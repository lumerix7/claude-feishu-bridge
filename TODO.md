# TODO

## Claude-native command alignment

Reference: codex-feishu-bridge command set and Claude Agent SDK capabilities.

### Add `/fork [<session-id>]`

Fork the current (or specified) session using SDK `forkSession()`.
- No args: fork the currently bound session
- With `<session-id>`: fork that specific session
- After fork: bind the new session ID to the conversation
- Import: `import { forkSession } from "@anthropic-ai/claude-agent-sdk"`

### Add `/memory`

Show active CLAUDE.md memory files for the bound project.
- Use `settingSources: ['project', 'user']` + inspect well-known paths:
  - `~/.claude/CLAUDE.md` (user memory)
  - `<project>/CLAUDE.md` (project memory)
  - `<project>/.claude/CLAUDE.md` (project memory alt)
- Show path + first N lines of each file found
- Optional: `/memory edit` to open in $EDITOR (out of scope for now)

### Add `/agents`

List configured Claude agents for the bound project.
- Use `query.supportedAgents()` from a lightweight init query
- Show: agent name, description, model
- Agents come from `.claude/settings.json` `agents` key or `--agents` CLI flag
