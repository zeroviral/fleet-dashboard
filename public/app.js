'use strict';

const state = {
  sessions: new Map(),
  cards: new Map(),
  defaults: { command: 'opencode', cwd: '' },
  activeId: null,
  serverOk: false,
  refreshTimer: null,
};

const terminalGrid = document.getElementById('terminal-grid');
const emptyState = document.getElementById('empty-state');
const sessionList = document.getElementById('session-list');
const sessionCount = document.getElementById('session-count');
const spawnForm = document.getElementById('spawn-form');
const spawnButton = document.getElementById('spawn-button');
const spawnError = document.getElementById('spawn-error');
const titleInput = document.getElementById('session-title');
const cwdInput = document.getElementById('session-cwd');
const commandInput = document.getElementById('session-command');
const cwdHistory = document.getElementById('cwd-history');
const serverDot = document.getElementById('server-dot');
const serverLabel = document.getElementById('server-label');

const STORAGE_CWD = 'fleet.lastCwd';
const STORAGE_HISTORY = 'fleet.cwdHistory';

const terminalTheme = {
  background: '#0a0c0f',
  foreground: '#d7dce5',
  cursor: '#6ee7b7',
  cursorAccent: '#0a0c0f',
  selectionBackground: '#2b4a41',
  black: '#11151a',
  red: '#f87171',
  green: '#6ee7b7',
  yellow: '#fbbf24',
  blue: '#7dd3fc',
  magenta: '#e879f9',
  cyan: '#67e8f9',
  white: '#e6e9ef',
  brightBlack: '#5f6875',
  brightRed: '#fca5a5',
  brightGreen: '#a7f3d0',
  brightYellow: '#fde68a',
  brightBlue: '#bae6fd',
  brightMagenta: '#f5d0fe',
  brightCyan: '#a5f3fc',
  brightWhite: '#f8fafc',
};

function api(path, options = {}) {
  return fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  }).then(async (response) => {
    if (response.status === 204) return null;
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new Error(body?.error || `Request failed (${response.status})`);
    }
    return body;
  });
}

function shortPath(value) {
  return value.replace(/^[A-Za-z]:\\Users\\[^\\]+\\/, '~\\');
}

function statusLabel(status, exitCode) {
  if (status === 'exited') return exitCode == null ? 'exited' : `exited (${exitCode})`;
  return status || 'unknown';
}

function setServerStatus(ok) {
  state.serverOk = ok;
  serverDot.classList.toggle('ok', ok);
  serverDot.classList.toggle('bad', !ok);
  serverLabel.textContent = ok ? 'local server connected' : 'server offline';
}

function loadCwdHistory() {
  let history = [];
  try {
    history = JSON.parse(localStorage.getItem(STORAGE_HISTORY) || '[]');
  } catch {
    history = [];
  }
  if (!Array.isArray(history)) history = [];
  cwdHistory.replaceChildren(
    ...history
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => {
        const option = document.createElement('option');
        option.value = item;
        return option;
      }),
  );
}

function rememberCwd(cwd) {
  localStorage.setItem(STORAGE_CWD, cwd);
  let history = [];
  try {
    history = JSON.parse(localStorage.getItem(STORAGE_HISTORY) || '[]');
  } catch {
    history = [];
  }
  if (!Array.isArray(history)) history = [];
  history = [cwd, ...history.filter((item) => item !== cwd)].slice(0, 12);
  localStorage.setItem(STORAGE_HISTORY, JSON.stringify(history));
  loadCwdHistory();
}

function updateEmptyState() {
  const hasCards = state.cards.size > 0;
  emptyState.hidden = hasCards;
  terminalGrid.hidden = !hasCards;
  sessionCount.textContent = String(state.sessions.size);
}

function makeButton(label, title, className = 'icon-button') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.title = title;
  return button;
}

function createCard(session) {
  const card = {
    id: session.id,
    session,
    ws: null,
    wsOpen: false,
    deleted: false,
    reconnectTimer: null,
    reconnectAttempts: 0,
    fitQueued: false,
    term: null,
    fit: null,
    element: null,
  };

  const element = document.createElement('article');
  element.className = 'terminal-card';
  element.dataset.sessionId = session.id;

  const head = document.createElement('header');
  head.className = 'terminal-head';

  const dot = document.createElement('span');
  dot.className = 'status-dot';
  dot.title = statusLabel(session.status, session.exitCode);

  const titleWrap = document.createElement('div');
  titleWrap.className = 'terminal-title';
  const name = document.createElement('strong');
  name.textContent = session.title;
  const pathLine = document.createElement('span');
  pathLine.textContent = session.cwd;
  pathLine.title = session.cwd;
  titleWrap.append(name, pathLine);

  const actions = document.createElement('div');
  actions.className = 'terminal-actions';

  const restartButton = makeButton('restart', 'Restart terminal');
  const maximizeButton = makeButton('max', 'Maximize terminal');
  const closeButton = makeButton('kill', 'Kill terminal', 'icon-button danger');
  actions.append(restartButton, maximizeButton, closeButton);

  head.append(dot, titleWrap, actions);

  const body = document.createElement('div');
  body.className = 'terminal-body';

  element.append(head, body);
  terminalGrid.append(element);

  card.element = element;
  card.dot = dot;
  card.name = name;
  card.pathLine = pathLine;
  card.body = body;
  card.restartButton = restartButton;
  card.maximizeButton = maximizeButton;

  const term = new Terminal({
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
    fontSize: 12.5,
    lineHeight: 1.18,
    cursorBlink: true,
    scrollback: 10000,
    theme: terminalTheme,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(body);
  card.term = term;
  card.fit = fit;

  term.onData((data) => send(card, { type: 'input', data }));
  term.onResize(({ cols, rows }) => send(card, { type: 'resize', cols, rows }));
  body.addEventListener('mousedown', () => setActive(card));
  body.addEventListener('focusin', () => setActive(card));

  const resizeObserver = new ResizeObserver(() => scheduleFit(card));
  resizeObserver.observe(body);
  card.resizeObserver = resizeObserver;

  restartButton.addEventListener('click', (event) => {
    event.stopPropagation();
    restartSession(card);
  });
  maximizeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMaximize(card);
  });
  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    deleteSession(card);
  });

  requestAnimationFrame(() => scheduleFit(card));
  connect(card);
  state.cards.set(session.id, card);
  renderSidebar();
  updateEmptyState();
  return card;
}

function updateCardSession(card, session) {
  card.session = { ...card.session, ...session };
  card.name.textContent = session.title ?? card.session.title;
  card.pathLine.textContent = card.session.cwd;
  card.pathLine.title = card.session.cwd;
  card.dot.className = `status-dot ${card.session.status}`;
  card.dot.title = statusLabel(card.session.status, card.session.exitCode);
  updateSidebarRow(card);
}

function scheduleFit(card) {
  if (card.fitQueued || card.deleted) return;
  card.fitQueued = true;
  requestAnimationFrame(() => {
    card.fitQueued = false;
    if (card.deleted || !card.fit || !card.term) return;
    if (!card.element.isConnected || card.element.offsetParent === null) return;
    try {
      card.fit.fit();
    } catch {
      // xterm may not have measured its cells yet; next resize will retry.
    }
  });
}

function connect(card) {
  if (card.deleted) return;
  if (card.reconnectTimer) {
    clearTimeout(card.reconnectTimer);
    card.reconnectTimer = null;
  }
  if (card.ws) {
    card.ws.onclose = null;
    try {
      card.ws.close();
    } catch {
      // Ignore.
    }
  }

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws/${card.id}`);
  card.ws = ws;
  card.wsOpen = false;

  ws.addEventListener('open', () => {
    card.wsOpen = true;
    card.reconnectAttempts = 0;
    scheduleFit(card);
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'snapshot':
        card.term.reset();
        if (message.data) card.term.write(message.data);
        if (message.session) updateCardSession(card, message.session);
        scheduleFit(card);
        break;
      case 'output':
        if (typeof message.data === 'string') card.term.write(message.data);
        break;
      case 'reset':
        card.term.reset();
        break;
      case 'exit':
        card.term.write(`\r\n\x1b[38;5;203m[process exited${message.code == null ? '' : `: ${message.code}`}]\x1b[0m\r\n`);
        break;
      case 'status':
        updateCardSession(card, { status: message.status, exitCode: message.exitCode ?? null });
        break;
      default:
        break;
    }
  });

  ws.addEventListener('close', () => {
    card.wsOpen = false;
    if (card.ws === ws) card.ws = null;
    if (card.deleted) return;
    if (card.session.status === 'exited') return;
    card.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** card.reconnectAttempts, 10000);
    card.reconnectTimer = setTimeout(() => connect(card), delay);
  });

  ws.addEventListener('error', () => {
    // close handler drives reconnection.
  });
}

function send(card, message) {
  if (card.ws && card.ws.readyState === WebSocket.OPEN) {
    card.ws.send(JSON.stringify(message));
  }
}

function setActive(card) {
  if (state.activeId === card.id) {
    card.term.focus();
    return;
  }
  state.activeId = card.id;
  for (const other of state.cards.values()) {
    other.element.classList.toggle('active', other.id === card.id);
  }
  for (const row of sessionList.querySelectorAll('.session-row')) {
    row.classList.toggle('active', row.dataset.sessionId === card.id);
  }
  card.term.focus();
}

function toggleMaximize(card) {
  const maximized = card.element.classList.toggle('maximized');
  card.maximizeButton.textContent = maximized ? 'restore' : 'max';
  card.maximizeButton.title = maximized ? 'Restore terminal' : 'Maximize terminal';
  scheduleFit(card);
  if (maximized) card.term.focus();
}

async function restartSession(card) {
  card.deleted = false;
  try {
    const data = await api(`/api/sessions/${card.id}/restart`, { method: 'POST' });
    if (data?.session) updateCardSession(card, data.session);
    card.term.focus();
  } catch (error) {
    card.term.write(`\r\n\x1b[38;5;203m[restart failed: ${String(error.message).replace(/\x1b/g, '')}]\x1b[0m\r\n`);
  }
}

async function deleteSession(card) {
  if (!window.confirm(`Kill "${card.session.title}"? The running process will be terminated.`)) {
    return;
  }
  card.deleted = true;
  if (card.reconnectTimer) clearTimeout(card.reconnectTimer);
  if (card.ws) {
    card.ws.onclose = null;
    try {
      card.ws.close();
    } catch {
      // Ignore.
    }
  }
  try {
    await api(`/api/sessions/${card.id}`, { method: 'DELETE' });
  } catch (error) {
    card.deleted = false;
    window.alert(`Could not kill session: ${error.message}`);
    return;
  }
  card.resizeObserver?.disconnect();
  card.term.dispose();
  card.element.remove();
  state.cards.delete(card.id);
  state.sessions.delete(card.id);
  if (state.activeId === card.id) state.activeId = null;
  renderSidebar();
  updateEmptyState();
}

function makeSidebarRow(session) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'session-row';
  row.dataset.sessionId = session.id;

  const dot = document.createElement('span');
  dot.className = `status-dot ${session.status}`;

  const meta = document.createElement('span');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = session.title;
  const pathLabel = document.createElement('span');
  pathLabel.className = 'path';
  pathLabel.textContent = shortPath(session.cwd);
  pathLabel.title = session.cwd;
  meta.append(name, pathLabel);

  row.append(dot, meta);
  row.addEventListener('click', () => {
    const card = state.cards.get(session.id);
    if (!card) return;
    setActive(card);
    card.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (card.element.classList.contains('maximized')) card.term.focus();
  });
  return row;
}

function renderSidebar() {
  const rows = [...state.cards.values()].map((card) => {
    const row = makeSidebarRow(card.session);
    row.classList.toggle('active', card.id === state.activeId);
    return row;
  });
  sessionList.replaceChildren(...rows);
  sessionCount.textContent = String(state.sessions.size);
}

function updateSidebarRow(card) {
  const row = sessionList.querySelector(`.session-row[data-session-id="${card.id}"]`);
  if (!row) return;
  const dot = row.querySelector('.status-dot');
  if (dot) dot.className = `status-dot ${card.session.status}`;
  const name = row.querySelector('.name');
  if (name) name.textContent = card.session.title;
  const pathLabel = row.querySelector('.path');
  if (pathLabel) {
    pathLabel.textContent = shortPath(card.session.cwd);
    pathLabel.title = card.session.cwd;
  }
}

function removeCard(sessionId) {
  const card = state.cards.get(sessionId);
  if (!card) return;
  card.deleted = true;
  if (card.reconnectTimer) clearTimeout(card.reconnectTimer);
  if (card.ws) {
    card.ws.onclose = null;
    try {
      card.ws.close();
    } catch {
      // Ignore.
    }
  }
  card.resizeObserver?.disconnect();
  card.term.dispose();
  card.element.remove();
  state.cards.delete(sessionId);
  state.sessions.delete(sessionId);
  if (state.activeId === sessionId) state.activeId = null;
}

async function refreshSessions() {
  try {
    const data = await api('/api/sessions');
    setServerStatus(true);
    state.defaults = data.defaults || state.defaults;
    commandInput.placeholder = state.defaults.command || 'opencode';
    const remote = new Map(data.sessions.map((session) => [session.id, session]));

    for (const [id, session] of remote) {
      state.sessions.set(id, session);
      const card = state.cards.get(id);
      if (!card) {
        createCard(session);
      } else {
        updateCardSession(card, session);
      }
    }

    for (const id of [...state.cards.keys()]) {
      if (!remote.has(id)) removeCard(id);
    }

    renderSidebar();
    updateEmptyState();
  } catch {
    setServerStatus(false);
  }
}

async function spawnSession(event) {
  event?.preventDefault();
  spawnError.hidden = true;
  const cwd = cwdInput.value.trim();
  if (!cwd) {
    spawnError.textContent = 'Enter a directory.';
    spawnError.hidden = false;
    cwdInput.focus();
    return;
  }

  spawnButton.disabled = true;
  spawnButton.textContent = 'Spawning…';
  try {
    const command = commandInput.value.trim();
    const data = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title: titleInput.value.trim() || undefined,
        cwd,
        command: command || undefined,
      }),
    });
    rememberCwd(cwd);
    titleInput.value = '';
    commandInput.value = '';
    const session = data.session;
    state.sessions.set(session.id, session);
    const card = createCard(session);
    setActive(card);
    card.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setServerStatus(true);
  } catch (error) {
    spawnError.textContent = error.message;
    spawnError.hidden = false;
  } finally {
    spawnButton.disabled = false;
    spawnButton.textContent = 'Spawn agent';
  }
}

spawnForm.addEventListener('submit', spawnSession);

window.addEventListener('resize', () => {
  for (const card of state.cards.values()) scheduleFit(card);
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const card of state.cards.values()) {
    if (card.element.classList.contains('maximized')) toggleMaximize(card);
  }
});

async function init() {
  loadCwdHistory();
  titleInput.value = '';
  commandInput.value = '';
  commandInput.placeholder = 'opencode';

  await refreshSessions();
  cwdInput.value = localStorage.getItem(STORAGE_CWD) || state.defaults.cwd || '';
  if (!state.defaults.cwd) cwdInput.focus();

  state.refreshTimer = setInterval(refreshSessions, 5000);
}

init();
