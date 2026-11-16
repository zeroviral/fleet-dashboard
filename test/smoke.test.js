'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(150);
  }
  throw new Error('Server did not start in time');
}

function collectOutput(port, sessionId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${sessionId}`);
    const timer = setTimeout(() => {
      ws.close();
      resolve(output);
    }, timeoutMs);

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === 'snapshot' || message.type === 'output') {
        output += message.data || '';
      }
      if (output.includes('fleet-smoke-ok')) {
        clearTimeout(timer);
        ws.close();
        resolve(output);
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test('spawns a pty session and streams terminal output', async (t) => {
  const port = 46000 + Math.floor(Math.random() * 2000);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-dashboard-test-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      FLEET_DEFAULT_CWD: workdir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  child.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });

  t.after(async () => {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    await sleep(300);
    try {
      fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // A lingering ConPTY child can keep the temp directory locked briefly.
    }
  });

  await waitForServer(port).catch((error) => {
    throw new Error(`${error.message}\n${serverLog}`);
  });

  const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'smoke',
      cwd: workdir,
      command: 'Write-Output "fleet-smoke-ok"; Start-Sleep -Seconds 30',
    }),
  });
  assert.equal(createResponse.status, 201);
  const { session } = await createResponse.json();
  assert.equal(session.title, 'smoke');
  assert.equal(session.cwd, workdir);

  const output = await collectOutput(port, session.id, 8000);
  assert.match(output, /fleet-smoke-ok/);

  const listResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.ok(list.sessions.some((item) => item.id === session.id));

  const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}`, {
    method: 'DELETE',
  });
  assert.equal(deleteResponse.status, 204);
});
