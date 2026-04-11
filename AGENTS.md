# claude-feishu-bridge

`claude-feishu-bridge` is a Feishu-native control surface for local Claude Code sessions. Feishu is the chat UI, Claude Code is the execution engine, and native Claude sessions remain the only source of truth for conversation state. The bridge should only keep conversation-to-session bindings, project/runtime metadata, and transport state. It should not invent a second assistant layer or replay history to fake continuity.

## Refs & Docs

- Main project doc: [`README.md`](./README.md)
- Sibling bridge reference: `../codex-feishu-bridge/`
- Entry point: [`src/index.ts`](./src/index.ts)
- Main app flow: [`src/core/app.ts`](./src/core/app.ts)
- Claude backend: [`src/adapters/claude/claude-runtime.ts`](./src/adapters/claude/claude-runtime.ts)
- Feishu transport: [`src/adapters/feishu/feishu-gateway.ts`](./src/adapters/feishu/feishu-gateway.ts)
- Config loader: [`src/config/env.ts`](./src/config/env.ts)
- Feishu long connection docs: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode>
- Feishu CardKit streaming docs: <https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview>
- Claude Agent SDK package/docs: <https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk>

## Development / Install

- Full local install + build + user service render/restart: `./install.sh`
- Deps: `npm install`
- Local dev watch: `npm run dev`
- Local CLI without Feishu: `npm run cli`
- Foreground daemon: `npm start`
- Service template: [`deploy/claude-feishu-bridge.service`](./deploy/claude-feishu-bridge.service)
- Installed process env: `~/.config/claude-feishu-bridge/bridge.env`
- Example env: [`deploy/config/bridge.env.example`](./deploy/config/bridge.env.example)

## Testing

- Typecheck only: `npm run check`
- Build: `npm run build`
- Tests: `npm test`
- Gateway-focused tests: `npm test -- --test-name-pattern='splitMessageText|buildStreamingLineFrames|renderOutgoingBody'`
- Practical verification path:
  - `systemctl --user status claude-feishu-bridge`
  - `journalctl --user -u claude-feishu-bridge -f`
  - `npm run cli`

## Runtime Shape

- Backend mode is Claude Agent SDK only. There is no alternate `app-server` backend here.
- The bridge passes `CLAUDE_BIN` to the SDK as `pathToClaudeCodeExecutable`.
- The bridge forwards process env to Claude SDK runs, so proxy settings in `bridge.env` affect both Node HTTP calls and spawned Claude executions.
- Session bindings persist in the local binding store. Model and effort overrides are conversation-local and in-memory only.
- The installer and systemd unit are expected to use `~/.config/claude-feishu-bridge/bridge.env`.

## Tips

- Be proactive: when a durable rule changes, update this file briefly; keep full operator detail in [`README.md`](./README.md) or other docs.
- Prefer simple first, then one step more.
- Keep the bridge thin. Claude native sessions are the authority; the bridge should not duplicate state beyond bindings and transport metadata.
- Keep `/rename` native and aligned with sibling bridges; use `--session <session-id>` to target one session without rebinding.
- Prefer fixing behavior in the app layer or gateway once, not by adding command-specific rendering hacks in multiple places.
- Preserve the streaming-first Feishu behavior. Rich card updates and pagination are part of the intended UX.
- Large fenced output can still render differently across Feishu desktop and mobile clients; keep the gateway line-safe and keep the caveat documented in [`docs/feishu-rendering-caveats.md`](./docs/feishu-rendering-caveats.md).
- Keep shell passthrough commands constrained to the bound project and allowed roots model. Prefer `commands.alias` for command expansions and `commands.direct` for identity local commands; keep `commands.map` as a legacy alias field.
- Keep wrapped command handling centralized: usage/validation issues stay warning/orange, and executed wrapped commands return one raw output shape with merged stdout/stderr plus a leading `Code: ...` line; non-zero exits render red.
- Useful runtime checks:
  - `systemctl --user cat claude-feishu-bridge`
  - `systemctl --user status claude-feishu-bridge`
  - `journalctl --user -u claude-feishu-bridge -n 100 --no-pager`
  - `which -a claude-feishu-bridge`
