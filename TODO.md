# TODO

## Claude-native command alignment

Reference: codex-feishu-bridge command set and Claude Agent SDK capabilities.

### Add `/compact`
Send Claude's own `/compact` slash command as a turn via the SDK.
- Implementation: `query({ prompt: "/compact", options: { resume: sessionId, cwd: project } })`
- Show compact result (summary preview, token counts from `SDKResultMessage`)
- Guard: require bound session, no active run

### Add `/fork [<session-id>]`
Fork the current (or specified) session using SDK `forkSession()`.
- No args: fork the currently bound session
- With `<session-id>`: fork that specific session
- After fork: bind the new session ID to the conversation
- Import: `import { forkSession } from "@anthropic-ai/claude-agent-sdk"`

### Enhance `/model` — add `--list`
List available Claude models using `query.supportedModels()`.
- `/model` — show current model (existing)
- `/model --list` — list available models from a lightweight init query
- `/model <name>` — set model for conversation (existing)
- Need to create a short-lived `query()` just to call `initializationResult()` + `supportedModels()`

### Add `/memory`
Show active CLAUDE.md memory files for the bound project.
- Use `settingSources: ['project', 'user']` + inspect well-known paths:
  - `~/.claude/CLAUDE.md` (user memory)
  - `<project>/CLAUDE.md` (project memory)
  - `<project>/.claude/CLAUDE.md` (project memory alt)
- Show path + first N lines of each file found
- Optional: `/memory edit` to open in $EDITOR (out of scope for now)

### Fix `/permission` — add missing mode + align help
- Add `dontAsk` to valid modes list (currently missing from validation and help text)
- Full valid set: `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`
- Consider alias `/approvals` → `/permission` for codex parity (or just note in help)

### Add `/agents`
List configured Claude agents for the bound project.
- Use `query.supportedAgents()` from a lightweight init query
- Show: agent name, description, model
- Agents come from `.claude/settings.json` `agents` key or `--agents` CLI flag

## SDK migration follow-up

### `/session list` enhancement
Currently shows all sessions across all projects (from `listSessions()`).
- Add `--project` flag to filter by bound project: `listSessions({ dir: project })`
- Show git branch (`SDKSessionInfo.gitBranch`) if present
- Show tag (`SDKSessionInfo.tag`) if set

### `/status` — show SDK/Claude Code version from init message
Currently calls `claude --version` via `execFileAsync`.
- Capture `SDKSystemMessage.claude_code_version` during a turn and cache it
- Or: parse `claude --version` output once at startup and store

### Startup ready notification
- Include SDK version (`@anthropic-ai/claude-agent-sdk` package version) alongside Claude Code version

## Feishu rendering

### Shell command output — use `renderFencedBlock` helper
Currently `handleShellCommand` returns bare triple-backtick fences.
- Port codex bridge's `commandMetaCard()` pattern: send meta (project + command) as early update, return content-only fenced block
- Already done in copilot bridge (commit d54a30c)
