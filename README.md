# Fleet Dashboard

A local web dashboard for running multiple `opencode` agent instances in different project
directories. Each agent runs in a persistent native PTY, streamed to the browser over a
WebSocket and rendered with xterm.js.

## Why Node instead of Python

The original terminal multiplexer prototype used the Python `vmux` package. This version uses
`node-pty` directly against Windows ConPTY, so the server does no Python bridging and terminal
I/O goes from PTY to WebSocket to xterm.js without an extra interpreter in the path.

## Requirements

- Windows 10/11 (ConPTY)
- Node.js 20 or newer
- `opencode` on `PATH` (`Get-Command opencode` should resolve)

## Install and run

```powershell
cd C:\Users\User\fleet-dashboard
npm install
npm start
```

Open <http://127.0.0.1:4317>.

```text
Directory: C:\Users\User\some-project
Command:   opencode
```

`Command` is optional and defaults to `opencode`. It is executed inside a PowerShell session
whose working directory is the chosen project.

## Behavior

- Closing or refreshing a browser tab does **not** stop an agent. Sessions live in the server
  process until you press `kill`.
- `restart` kills the PTY and starts the command again in the same directory.
- Output is buffered per session (last 512 KiB), so reconnecting clients get terminal history.
- Open the same dashboard in more than one tab to watch a session from multiple windows.

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4317` | HTTP/WebSocket port |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback unless you add your own auth/proxy |
| `FLEET_COMMAND` | `opencode` | Default agent command |
| `FLEET_DEFAULT_CWD` | server cwd | Prefilled directory in the spawn form |
| `FLEET_SHELL` | `powershell.exe` | Shell used to host the PTY |

There is no authentication. Do not bind the server to `0.0.0.0` on an untrusted network; use
SSH port forwarding or a reverse proxy with auth if you need remote access.

## Development

```powershell
npm run dev    # node --watch
npm test       # spawns a PTY session and verifies WebSocket streaming
```

## Layout

```text
index.js              Express REST API + WebSocket server + PTY session manager
public/index.html     Dashboard shell
public/app.js         Session list, spawn form, xterm terminals, reconnect logic
public/styles.css     Dark UI and terminal grid
test/smoke.test.js    End-to-end PTY/WebSocket smoke test
```
