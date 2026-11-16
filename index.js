'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const express = require('express');
const pty = require('node-pty');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 4317;
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_COMMAND = process.env.FLEET_COMMAND || 'opencode';
const DEFAULT_CWD = process.env.FLEET_DEFAULT_CWD || process.cwd();
const MAX_BUFFER_CHARS = 512 * 1024;
const FLUSH_INTERVAL_MS = 5;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));

const sessions = new Map();

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function trimBuffer(buffer) {
  if (buffer.length <= MAX_BUFFER_CHARS) return buffer;
  return buffer.slice(buffer.length - MAX_BUFFER_CHARS);
}

function validNumber(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

class Session {
  constructor({ title, cwd, command }) {
    this.id = crypto.randomBytes(4).toString('hex');
    this.title = title;
    this.cwd = cwd;
    this.command = command;
    this.createdAt = new Date().toISOString();
    this.buffer = '';
    this.queue = '';
    this.flushTimer = null;
    this.clients = new Set();
    this.pty = null;
    this.exitCode = null;
    this.status = 'starting';
  }

  start() {
    this.status = 'starting';
    this.exitCode = null;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
    );
    const shellCommand = `Set-Location -LiteralPath ${psQuote(this.cwd)}; ${this.command}`;

    const proc = pty.spawn(
      process.env.FLEET_SHELL || 'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NoExit', '-Command', shellCommand],
      {
        name: 'xterm-256color',
        cwd: this.cwd,
        env,
        cols: 120,
        rows: 32,
        useConpty: true,
      },
    );
    this.pty = proc;

    proc.onData((data) => {
      if (this.pty === proc) this.onData(data);
    });
    proc.onExit(({ exitCode }) => {
      if (this.pty === proc) this.onExit(exitCode);
    });

    this.status = 'running';
    this.broadcast({ type: 'status', status: this.status, exitCode: this.exitCode });
  }

  onData(data) {
    this.buffer = trimBuffer(this.buffer + data);
    this.queue += data;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const chunk = this.queue;
      this.queue = '';
      if (chunk) this.broadcast({ type: 'output', data: chunk });
    }, FLUSH_INTERVAL_MS);
  }

  onExit(exitCode) {
    this.status = 'exited';
    this.exitCode = exitCode;
    this.pty = null;
    this.broadcast({ type: 'exit', code: exitCode });
    this.broadcast({ type: 'status', status: this.status, exitCode });
  }

  write(data) {
    if (this.pty && this.status === 'running') this.pty.write(data);
  }

  resize(cols, rows) {
    if (!this.pty || this.status !== 'running') return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // The PTY may have exited between the status check and resize.
    }
  }

  restart() {
    this.kill();
    this.buffer = '';
    this.queue = '';
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.broadcast({ type: 'reset' });
    this.start();
  }

  kill() {
    const proc = this.pty;
    this.pty = null;
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // Already dead.
    }
  }

  flushNow() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const chunk = this.queue;
    this.queue = '';
    if (chunk) this.broadcast({ type: 'output', data: chunk });
  }

  broadcast(message) {
    if (!this.clients.size) return;
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  attach(ws) {
    this.flushNow();
    const snapshot = {
      type: 'snapshot',
      data: this.buffer,
      session: this.toJSON(),
    };
    ws.send(JSON.stringify(snapshot));
    this.clients.add(ws);
  }

  detach(ws) {
    this.clients.delete(ws);
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      command: this.command,
      status: this.status,
      exitCode: this.exitCode,
      createdAt: this.createdAt,
    };
  }
}

function createSession({ title, cwd, command }) {
  const session = new Session({
    title: title || path.basename(cwd) || 'session',
    cwd,
    command: command || DEFAULT_COMMAND,
  });
  sessions.set(session.id, session);
  session.start();
  return session;
}

app.get('/api/sessions', (req, res) => {
  res.json({
    sessions: [...sessions.values()].map((session) => session.toJSON()),
    defaults: { command: DEFAULT_COMMAND, cwd: DEFAULT_CWD },
  });
});

app.post('/api/sessions', (req, res) => {
  const { title, cwd, command } = req.body || {};
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return res.status(400).json({ error: 'cwd is required' });
  }
  const resolved = path.resolve(cwd.trim());
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return res.status(400).json({ error: `Directory does not exist: ${resolved}` });
  }
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: `Not a directory: ${resolved}` });
  }
  if (title != null && (typeof title !== 'string' || title.length > 120)) {
    return res.status(400).json({ error: 'title must be a string under 120 characters' });
  }
  if (command != null && (typeof command !== 'string' || command.length > 500 || !command.trim())) {
    return res.status(400).json({ error: 'command must be a non-empty string under 500 characters' });
  }
  const session = createSession({
    title: title?.trim(),
    cwd: resolved,
    command: command?.trim(),
  });
  return res.status(201).json({ session: session.toJSON() });
});

app.post('/api/sessions/:id/restart', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.restart();
  return res.json({ session: session.toJSON() });
});

app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.kill();
  sessions.delete(session.id);
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1000, 'Session deleted');
    }
  }
  session.clients.clear();
  return res.status(204).end();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, sessions: sessions.size, uptime: process.uptime() });
});

wss.on('connection', (ws, req) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    ws.close(1008, 'Bad request');
    return;
  }
  const match = url.pathname.match(/^\/ws\/([a-f0-9]{8})$/);
  const session = match ? sessions.get(match[1]) : null;
  if (!session) {
    ws.close(4404, 'Session not found');
    return;
  }

  session.attach(ws);

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'input' && typeof message.data === 'string') {
      if (message.data.length <= 1024 * 1024) session.write(message.data);
      return;
    }
    if (message.type === 'resize') {
      if (validNumber(message.cols, 1, 1000) && validNumber(message.rows, 1, 1000)) {
        session.resize(message.cols, message.rows);
      }
    }
  });

  ws.on('close', () => session.detach(ws));
  ws.on('error', () => session.detach(ws));
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`fleet-dashboard listening on http://${displayHost}:${PORT}`);
  console.log(`Default command: ${DEFAULT_COMMAND}`);
  console.log(`Default cwd: ${DEFAULT_CWD}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn('WARNING: dashboard is bound to a non-loopback address and has no authentication.');
  }
});

function shutdown() {
  for (const session of sessions.values()) session.kill();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
