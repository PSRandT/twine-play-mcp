# twine-play-mcp

**English** · [简体中文](README-zh.md)

## ChatGPT Remote MCP

This fork adds a **private, single-user** Streamable HTTP profile while preserving
all 15 original local stdio tools. See [remote setup, security model, tests and
limits](REMOTE.md). The baseline is `05cee6f68a4ef3ecadbb07f5d7aaa27c500a87a1`
(package `0.2.1`). The original quick start and tool table below describe local mode.

Remote mode has 11 tools and requires a private endpoint credential, sandboxed
Chromium, and a host that permits Chromium's sandbox namespaces. A green health
check alone does not establish browser or ChatGPT compatibility.

An MCP server that lets AI agents **play, test and QA Twine / interactive-fiction HTML games**.

The agent reads the current passage, clicks numbered choices, fills inputs, watches story
variables, answers game dialogs, snapshots state to explore branches, and can hand the user a
live view of the real page — through a small, token-friendly tool surface instead of generic
browser automation.

```
Agent  ──MCP(stdio)──>  twine-play-mcp  ──Playwright──>  headless Chrome
                              │                               │
                              │  static server (127.0.0.1)    │  injected page bridge
                              └────────> game HTML <──────────┘
```

## Requirements

- **Node.js ≥ 20**
- **Google Chrome** installed (used via `channel: 'chrome'` — no 200 MB browser download)
- Linux, macOS or Windows

## Install

```bash
npm install -g twine-play-mcp   # or run it with: npx twine-play-mcp
```

The package ships the compiled server and the page bridge, so there is no build step.

## Configure

Add the server to your MCP client. Any `mcpServers`-style client works:

```json
{
  "mcpServers": {
    "twine-play": {
      "command": "npx",
      "args": ["-y", "twine-play-mcp"]
    }
  }
}
```

OpenCode uses its own shape (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "twine-play": { "type": "local", "command": ["npx", "-y", "twine-play-mcp"], "enabled": true }
  }
}
```

Ready-made files live in [`examples/`](examples). Environment variables — all optional:

- `TWMCP_CHROME_PATH` — Chrome executable, if `channel: 'chrome'` cannot find it
- `TWMCP_DOWNLOAD_DIR` — where browser downloads are captured (default `~/.cache/twine-play-mcp/downloads`, with automatic fallback if unwritable)
- `TWMCP_VIEW_HOST` / `TWMCP_VIEW_PORT` — live-view bind host (default `127.0.0.1`) and first port (default `4571`, auto-increments)
- `TWMCP_BLOCK_TRACKERS` — set to `0` to stop blocking analytics hosts during playtesting

## Quick start

Ask your agent to do this — **the game path is an argument to the `open_game` tool, not a CLI
argument**. There is no `twine-play-mcp game.html`.

> Open `/path/to/game.html` with twine-play-mcp and tell me what the first passage says.

What happens under the hood, and what the agent sees:

```
open_game({ source: "/path/to/game.html" })
  Opened game "game_c5ac1a" (/path/to/game.html)
  game_id: game_c5ac1a
  Story: TS Ero Trap Dungeon · Format: sugarcube 2.31.1 · ifid: ...
  Served from: http://127.0.0.1:41235/
  [sugarcube 2.31.1 · step 0 · engine=idle · passage: Title]
  ...
  Choices (1):
    1. Start -> Prologue

choose({ choice: 1 })          # or click_ui / interact / navigate
  Clicked: "Start" -> Prologue
  [sugarcube 2.31.1 · step 1 · engine=idle · passage: Prologue]
  ...

observe({ for_text: "You wake up" })    # wait for a timed passage, then read
interact({ ref: "i1", value: "Shiori" }) # fill a form field
snapshot({ action: "save", name: "before-boss" })
live_view({})                  # hand the user a URL to watch the real page
```

`game_id` is optional while exactly one game is open — omit it for less noise. With several games
open you must pass it, and the error lists the candidates.

## Tools

The surface is deliberately small: related verbs live together rather than each getting a
tool (`navigate` covers back/restart/goto, `snapshot` covers save/load/list, `get_logs` covers
console + journal). Types with one knob fold into `action:` / `kind:` parameters.

<!-- tools:begin -->
**Open & read**

| Tool | What it does |
| --- | --- |
| `open_game` | Open a local file/folder or an http(s) URL and get the first observation. |
| `observe` | Current passage text, choices, inputs, dialog and status. Pass `for_text` or `wait_ms` to wait first. |
| `session` | `list` the open games, or `close` one. |

**Act**

| Tool | What it does |
| --- | --- |
| `choose` | Click a choice by its 1-based number or by label — dialog buttons included. |
| `click_ui` | Click sidebar buttons and menus by ref, CSS selector or visible text. |
| `interact` | Fill an input/select/checkbox by ref, or press a key. |
| `navigate` | `back` one passage, `restart` the story, or `goto` a named passage. |

**Inspect**

| Tool | What it does |
| --- | --- |
| `find_ui` | Find controls by text or input name; inspect a DOM subtree or discover overlay panels. |
| `get_variables` | Read SugarCube `State.variables` by dot path, or a shallow key summary. |
| `get_logs` | Console errors/HTTP failures and the play journal. |
| `screenshot` | PNG of the viewport — canvas games and visual QA. |
| `live_view` | Let the user watch the real page in their browser (~1 fps). |

**Files & state**

| Tool | What it does |
| --- | --- |
| `snapshot` | `save` / `load` / `list` in-session state snapshots for branch exploration. |
| `upload_file` | Upload a mod `.zip`, `.save` or image into an `<input type=file>`. |
| `download_file` | `list` the persistent download folder, or `save`/`newest` a captured file. |
<!-- tools:end -->

Detail for any tool is in its own description — call it and read the parameters. Output is
formatted text for humans and models; pass `format: "json"` for `JSON.parse`-able output
(`observe`, `choose`, `click_ui`, `interact`, `navigate`, `snapshot`, `upload_file`,
`download_file`, `open_game`).

## Watching the page

`live_view` starts a tiny local server (once per MCP process) and returns a URL like
`http://127.0.0.1:4571/v/game_c5ac1a`. Open it and you watch the **actual tab the agent is
driving**: a JPEG frame roughly once a second, plus passage, step, engine state and recent actions.
It works with headless games, and frames are only captured while somebody is watching.

**Agents: pick exactly one view per game.** Use `live_view` by default (pass `open: true` once if
the user wants you to launch it). Use `open_game({ headless: false })` only when the user asks for a
real browser window, and do not add a live view on top of it. `screenshot` is a one-shot visual
check, never a stream. The server ships this policy in its MCP `instructions` field too.

## Format support

| Format | Detect | Text / choices | `get_variables` | Passage name | `navigate(back)` | `snapshot` |
| --- | --- | --- | --- | --- | --- | --- |
| **SugarCube 2.21+** | ✅ | ✅ | ✅ `State.variables` | ✅ | ✅ `Engine.backward` | ✅ `Save.base64` / `Save.deserialize` |
| **Harlowe 3** | ✅ | ✅ | — (engine internals are private) | — | ✅ sidebar undo | — |
| **Snowman 2** | ✅ | ✅ | — (use `observe(include_variables:true)`) | ✅ | — | ✅ state JSON |
| **Chapbook 1** | ✅ | ✅ | — (use `observe(include_variables:true)`) | ✅ `trail` | — | ✅ `restoreFromObject` |
| **Unknown HTML** | generic | ✅ DOM heuristics | — | — | — | — |

`observe` reads variables for Snowman (`story.state`) and Chapbook (`engine.state`) as well; only
`get_variables`' dot-path lookup is SugarCube-specific. Everything degrades gracefully: an unknown
format still plays through the generic DOM path, and format-specific tools report `unsupported`
instead of failing.

## Troubleshooting

- **`Could not launch Chrome`** — install Google Chrome, or point `TWMCP_CHROME_PATH` at the binary.
- **`Multiple HTML files in <dir>`** — pass the specific `.html` file instead of the folder.
- **Nothing happens with the file path** — the path goes to `open_game`; the CLI takes no arguments.
- **Live view port busy** — it auto-increments from 4571; use the URL that was returned.
- **Downloads not appearing** — read the folder path printed by `download_file(action:"list")`; it falls back to a writable location.
- **A tool reports `unsupported`** — that story format lacks the API (see the matrix above).

## Safety notes

- Page scripts run in Chrome's sandbox; the bridge never exposes Node to the page. No arbitrary `eval` tool is exposed.
- Analytics/tracker hosts are blocked by default (`TWMCP_BLOCK_TRACKERS=0` to disable).
- Links that leave the game are blocked unless `allow_external: true`. `open_game` serves a local game over `127.0.0.1` and reads files under the served root only.

## Development

```bash
git clone https://github.com/adorablelovelymia/twine-play-mcp.git
cd twine-play-mcp
npm install
npm test            # build + 4-format fixture checks + tool-surface snapshot/budget
```

`npm test` needs no external game — the fixtures are in the repo. Heavier checks
(`npm run smoke`, `npm run spike`, `npm run clarity`) drive a real game and need
`TWMCP_GAME=/path/to/game.html`; without it they skip.

Architecture, the playbook for adding a story-format adapter, the script index and the roadmap
are in **[CONTRIBUTING.md](CONTRIBUTING.md)**.
