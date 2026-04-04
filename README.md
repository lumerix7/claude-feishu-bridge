# claude-feishu-bridge

Feishu-native control surface for local Claude runs.

## Setup

1. Fill `.env` with Feishu credentials.
2. Set `CLAUDE_BIN=/opt/bin/claude-run` if that wrapper is the intended Claude entrypoint.
3. Copy the same proxy environment used by the bridge host into `.env` so both Node and spawned Claude runs inherit it:
   - `HTTP_PROXY`
   - `HTTPS_PROXY`
   - `ALL_PROXY`
   - `NO_PROXY`
   - optional lowercase variants if your local tooling expects them
4. Install and build:

```bash
./install.sh
```

## Required `.env` values

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BOT_OPEN_ID=ou_xxx
CLAUDE_BIN=/opt/bin/claude-run
```

Optional:

```dotenv
FEISHU_STARTUP_NOTIFY_CHAT_ID=oc_xxx
```

## Run

- `npm run cli` for local interactive testing
- `npm start` for foreground websocket mode
- `systemctl --user start claude-feishu-bridge` for background service mode

## Verify

- `systemctl --user status claude-feishu-bridge`
- `journalctl --user -u claude-feishu-bridge -f`

If the service is started by `systemd`, it now reads the repo-local `.env`, so Feishu credentials, proxy env, and `CLAUDE_BIN` are shared by both the bridge and spawned Claude processes.
