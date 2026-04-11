# claude-feishu-bridge

Feishu-native control surface for Claude Code sessions. A daemon that exposes Claude Code to Feishu (Lark) chats via WebSocket: users type slash commands or plain prompts; the bridge routes them to Claude via the Claude Agent SDK and streams rich card replies back.

Large fenced output can still render a bit differently across Feishu desktop and mobile clients. Keep pagination line-safe and see [`docs/feishu-rendering-caveats.md`](./docs/feishu-rendering-caveats.md) before changing gateway chunking.

## Quick start

For the full local install plus Feishu app/robot setup, see [`docs/bridge-install-setup-guide.md`](./docs/bridge-install-setup-guide.md).

Install or update the bridge from this checkout:

```bash
./install.sh
```

Then fill in credentials at `~/.config/claude-feishu-bridge/bridge.env` and start the service.

## Credentials (`bridge.env`)

`install.sh` creates `~/.config/claude-feishu-bridge/bridge.env` on first run. Required:

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BOT_OPEN_ID=ou_xxx
CLAUDE_BIN=/path/to/node/bin/claude
```

Optional:

```dotenv
FEISHU_STARTUP_NOTIFY_CHAT_ID=oc_xxx
BRIDGE_CONFIG_JSON=~/.config/claude-feishu-bridge/config.json
HTTP_PROXY=http://...
HTTPS_PROXY=http://...
NO_PROXY=localhost,...
```

`CLAUDE_BIN` is passed to the Claude Agent SDK as `pathToClaudeCodeExecutable`; the SDK uses it to invoke Claude Code. It is also called directly for `--version` queries. Proxy env vars set here are inherited by the bridge process and forwarded to the SDK runtime.

## Service

```bash
# Start / stop
systemctl --user start claude-feishu-bridge
systemctl --user stop  claude-feishu-bridge

# Monitor
systemctl --user status claude-feishu-bridge
journalctl --user -u claude-feishu-bridge -f
```

**Deploy** (build + install + restart):

```bash
bash install.sh
```

`npm run build` alone does **not** update the running service.

## Slash commands

### Core

| Command | Description |
|---------|-------------|
| `/help` | Show commands |
| `/status` | Current session and bridge state |
| `/new [-C \<dir\>] [-h]` | Create and bind a fresh Claude session |
| `/session [\<id\>\|list [options]] [-h]` | Inspect current session, inspect a specific session, or browse sessions |
| `/resume [\<id\>\|--last\|-n \<index\>\|--list] [-C \<dir\>] [-h]` | Bind a previous session |
| `/rename [--session \<id\>] ['name'\|-- name] [-h]` | Show or change a Claude session title |
| `/stop` | Stop the current active run |

### Claude

| Command | Description |
|---------|-------------|
| `/model [\<name\>\|list] [-e\|--effort \<level\>] [-h]` | Show or set model/effort level |
| `/permission [\<mode\>] [-h]` | Show or set permission mode (`bypassPermissions` `acceptEdits` `auto` `dontAsk` `plan` `default`) |

### Project

| Command | Description |
|---------|-------------|
| `/project [list\|bind [\<path\>] \| unbind] [-h]` | Show or manage the bound project |
| `/git [args...]` | Run `git` in the bound project |
| `/cat`, `/cp`, `/curl`, `/feishu`, `/find`, `/git-commit`, `/head`, `/ln`, `/ls`, `/mkdir`, `/mv`, `/pwd`, `/readlink`, `/rg`, `/rmdir`, `/sha256sum`, `/systemctl`, `/tail`, `/tar`, `/tavily-search`, `/todo`, `/touch`, `/trash`, `/trash-list`, `/trash-restore`, `/tree`, `/wc` | Run local project commands |

### Diagnostics

| Command | Description |
|---------|-------------|
| `/feishu [ws\|doctor]` | Feishu WebSocket and send diagnostics |
| `/log [-n \<count\>]` | Recent service logs from systemd journal |

## Configuration

Config cascades: **env vars** → **JSON config** (`BRIDGE_CONFIG_JSON`, default `~/.config/claude-feishu-bridge/config.json`) → **hardcoded defaults**.

`install.sh` creates `config.json` from `deploy/config/config.json` on first run; it is preserved on updates.

### Key `claude.*` knobs

| Key | Default | Description |
|-----|---------|-------------|
| `claudeBin` | `"claude"` | Path to Claude Code binary |
| `permissionMode` | `"bypassPermissions"` | Default Claude permission mode |
| `maxBudgetUsd` | `5` | Per-run budget cap (USD) |
| `runTimeoutMs` | `600000` | Run timeout (ms) |
| `streamUpdateIntervalMs` | `120` | Card update interval (ms) |
| `inlineBlocks` | `"on"` | Render tool-use blocks inline |

### Model / effort priority

Highest to lowest:

**Model:**
1. `/model <name>` — in-memory per conversation, reset on bridge restart; only accepted if name matches a known model alias or ID
2. `~/.claude/settings.json` `model` field — native Claude Code config
3. Session `init.model` — actual model reported by the SDK at session start; populated on boot for existing sessions, updated on each new turn

**Effort:**
1. `/model --effort <level>` — in-memory per conversation, reset on bridge restart; only accepted for `low | medium | high | max`
2. `~/.claude/settings.json` `effortLevel` field — native Claude Code config

The SDK init event does not expose effort level, so there is no session fallback for effort. Both model and effort are resolved via the same `resolveModelOptions` path used by the SDK call, footer, `/status`, and `/model`.

### Project paths

All project paths must fall under `project.allowedRoots` (default: `[$HOME]`). `project.defaultPath` sets the working directory when no binding exists.

## Architecture

Each Feishu conversation (p2p, group, thread) maps to a stable **conversation key** bound to a `SessionBinding` persisted in `storePath` (default `~/.local/share/claude-feishu-bridge/bindings.json`). The binding stores `claudeSessionId`, `project`, and `permissionMode`. Model/effort overrides are in-memory only; session `init.model` is cached in-memory at boot and on each turn.

### Message flow

```
Feishu WebSocket event
  → FeishuGateway           adapters/feishu/feishu-gateway.ts
      normalize + deduplicate
  → App.handleIncoming()    core/app.ts
      parseCommand() → built-in handler  OR  handleClaudeTurn()
  → SdkClaudeBackend        adapters/claude/claude-runtime.ts
      @anthropic-ai/claude-agent-sdk — streams timeline blocks
  → sendStreamSnapshot()
  → FeishuGateway.send()    rich Feishu card, updated in-place
```

Feishu cards are paginated if output exceeds `outputSoftLimit` (default 100 000 chars). Each chat has its own send queue to preserve ordering.

### Key files

| File | Role |
|------|------|
| `src/index.ts` | Entry point; daemon / cli / demo modes |
| `src/core/app.ts` | Main orchestrator; all command handlers and streaming |
| `src/core/command-router.ts` | Tokenizes slash commands; `ArgCursor` for flag parsing |
| `src/core/conversation-key.ts` | Derives stable binding keys from chat context |
| `src/adapters/feishu/feishu-gateway.ts` | Feishu SDK WebSocket + card rendering + send queue + retry |
| `src/adapters/claude/claude-runtime.ts` | `SdkClaudeBackend`; SDK messages → timeline blocks → text |
| `src/adapters/claude/backend.ts` | `ClaudeBackend` interface and shared types |
| `src/config/env.ts` | Config loader: env vars → JSON config → defaults |
| `src/store/binding-store.ts` | Persists `SessionBinding` (session ID, project, permission mode) |
| `src/types/domain.ts` | Core domain types |

## Development

```bash
npm run build       # TypeScript → dist/
npm run check       # type-check without emitting
npm run dev         # hot-reload dev server (tsx watch)
npm run cli         # local REPL — no Feishu, tests commands interactively
bash install.sh     # full deploy: build → pack → install globally → restart service
```

`CLAUDE.md` is a symlink to `AGENTS.md` (for Claude Code context). Run `bash link-claude-md.sh` to recreate it after a fresh clone.
