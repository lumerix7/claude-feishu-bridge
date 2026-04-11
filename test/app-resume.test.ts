import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { App } from "../src/core/app.js";
import type { AppConfig } from "../src/config/env.js";
import type { ClaudeBackend, RecentSessionMessage } from "../src/adapters/claude/backend.js";
import type { IncomingMessage } from "../src/types/domain.js";

function makeConfig(storePath: string): AppConfig {
  return {
    nodeEnv: "test",
    feishu: {
      appId: "app",
      appSecret: "secret",
      botOpenId: "bot",
      connectionMode: "websocket",
      wsAutoReconnect: true,
      wsLoggerLevel: "error",
      wsAgentKeepAliveMsecs: 1000,
      wsAgentMaxSockets: 1,
      wsAgentMaxFreeSockets: 1,
      wsConnectWarnAfterMs: 1000,
      reconnectReadyDebounceMs: 1000,
      sendRetryMaxAttempts: 1,
      sendRetryBaseDelayMs: 1,
      sendRetryMultiplier: 1,
      sendRetryMaxDelayMs: 1,
      titleMaxLength: 120
    },
    claude: {
      claudeBin: "claude",
      defaultModel: "",
      defaultEffortLevel: "",
      permissionMode: "bypassPermissions",
      maxBudgetUsd: 1,
      outputSoftLimit: 100000,
      runTimeoutMs: 1000,
      statusIntervalMs: 0,
      streamUpdateIntervalMs: 0,
      inlineBlocks: "on"
    },
    commands: { map: {}, alias: {}, direct: [] },
    project: {
      allowedRoots: ["/workspace"],
      defaultProject: "/workspace",
      knownPaths: [],
      listMaxCount: 100
    },
    storePath
  };
}

function makeMessage(text: string): IncomingMessage {
  return {
    messageId: "m1",
    chatId: "c1",
    chatType: "p2p",
    text
  };
}

function makeBackend(overrides: Partial<ClaudeBackend> = {}): ClaudeBackend {
  return {
    mode: "sdk",
    async runTurn() {
      throw new Error("not implemented");
    },
    async stop() {
      return false;
    },
    async listSessions() {
      return [];
    },
    async getSessionInfo() {
      return undefined;
    },
    async getLastUserMessage() {
      return undefined;
    },
    async getRecentSessionMessages() {
      return [];
    },
    async renameSession() {},
    async getVersion() {
      return undefined;
    },
    ...overrides
  };
}

test("resume help works regardless of -h position", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-"));
  try {
    const app = new App(makeConfig(path.join(tmp, "bindings.json")));

    const direct = await app.handleIncoming(makeMessage("/resume -h"));
    const trailing = await app.handleIncoming(makeMessage("/resume session-123 -h"));

    const directText = typeof direct === "string" ? direct : direct.text;
    const trailingText = typeof trailing === "string" ? trailing : trailing.text;
    assert.equal(trailingText, directText);
    assert.match(directText, /## Usage/);
    assert.match(directText, /`-, --last` Resume the most recent session/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("session help works regardless of -h position", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-"));
  try {
    const app = new App(makeConfig(path.join(tmp, "bindings.json")));

    const direct = await app.handleIncoming(makeMessage("/session -h"));
    const trailing = await app.handleIncoming(makeMessage("/session session-123 -h"));

    const directText = typeof direct === "string" ? direct : direct.text;
    const trailingText = typeof trailing === "string" ? trailing : trailing.text;
    assert.equal(trailingText, directText);
    assert.match(directText, /^# Session\n\nInspect the current bound session, inspect one specific Claude Code session, or browse recent sessions\./);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("session with an explicit session id renders that session without bound flags", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-"));
  try {
    const app = new App(makeConfig(path.join(tmp, "bindings.json")));
    await (app as any).store.put({
      conversationKey: "c1",
      claudeSessionId: "session-1",
      project: "/workspace",
      createdAt: "2026-04-09T12:27:00.000Z",
      updatedAt: "2026-04-09T12:27:00.000Z"
    });
    (app as any).claude = makeBackend({
      async getSessionInfo(sessionId: string) {
        if (sessionId !== "session-2") return undefined;
        return {
          sessionId,
          cwd: "/workspace/project-b",
          createdAt: Date.parse("2026-04-09T12:27:00.000Z"),
          summary: "summary preview"
        } as any;
      },
      async getLastUserMessage(sessionId: string) {
        return sessionId === "session-2" ? "latest prompt" : undefined;
      }
    });

    const result = await app.handleIncoming(makeMessage("/session session-2"));

    const text = typeof result === "string" ? result : result.text;
    assert.match(text, /- \*\*Session\*\*: `session-2`\n- \*\*Project\*\*: `\/workspace\/project-b`/);
    assert.doesNotMatch(text, /- \*\*Flags\*\*: .*bound/);
    assert.match(text, /- \*\*Last message\*\*:\n\n```text\nlatest prompt\n```$/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("resume without a selector warns and points to explicit latest aliases", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-"));
  try {
    const app = new App(makeConfig(path.join(tmp, "bindings.json")));

    const result = await app.handleIncoming(makeMessage("/resume"));

    assert.equal(typeof result, "object");
    assert.equal(result.severity, "warning");
    assert.equal(
      result.text,
      "- **Error**: pick a session explicitly, or use `-` to resume the most recent session\n- **Usage**: `/resume [<session-id>|-|--last|-n <index>|list|-h]`"
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("resume last alias replays recent messages with timestamps", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-"));
  try {
    const app = new App(makeConfig(path.join(tmp, "bindings.json")));
    const replayMessages: RecentSessionMessage[] = [
      {
        role: "assistant",
        text: "first line\n```inside```",
        timestamp: "2026-04-09T20:27:10.194+08:00"
      },
      {
        role: "user",
        text: "follow up",
        timestamp: "2026-04-09T20:27:32.000+08:00"
      }
    ];
    (app as any).claude = makeBackend({
      async listSessions() {
        return [{
          sessionId: "session-1",
          cwd: "/workspace",
          lastModified: "2026-04-09T12:27:32.000Z"
        }] as any;
      },
      async getSessionInfo() {
        return {
          sessionId: "session-1",
          cwd: "/workspace",
          createdAt: Date.parse("2026-04-09T12:27:00.000Z")
        } as any;
      },
      async getLastUserMessage() {
        return "latest prompt";
      },
      async getRecentSessionMessages() {
        return replayMessages;
      }
    });

    const updates: Array<string | { text: string; bodyFormat?: string }> = [];
    const result = await app.handleIncoming(
      makeMessage("/resume -"),
      undefined,
      async (text) => {
        updates.push(text);
      }
    );

    const text = typeof result === "string" ? result : result.text;
    assert.match(text, /- \*\*Session\*\*: `session-1`/);
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0], {
      text: "[Claude] 2026-04-09T20:27:10.194+08:00\n\nfirst line\n```inside```",
      bodyFormat: "raw-text"
    });
    assert.deepEqual(updates[1], {
      text: "[User] 2026-04-09T20:27:32.000+08:00\n\nfollow up",
      bodyFormat: "raw-text"
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("resume replays recent messages even when rebinding the same session", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-"));
  try {
    const app = new App(makeConfig(path.join(tmp, "bindings.json")));
    (app as any).claude = makeBackend({
      async getSessionInfo() {
        return {
          sessionId: "session-1",
          cwd: "/workspace",
          createdAt: Date.parse("2026-04-09T12:27:00.000Z")
        } as any;
      },
      async getLastUserMessage() {
        return "latest prompt";
      },
      async getRecentSessionMessages() {
        return [
          {
            role: "assistant",
            text: "still replay",
            timestamp: "2026-04-09T20:27:10.194+08:00"
          }
        ];
      }
    });
    await (app as any).store.put({
      conversationKey: "c1",
      claudeSessionId: "session-1",
      project: "/workspace",
      createdAt: "2026-04-09T12:27:00.000Z",
      updatedAt: "2026-04-09T12:27:00.000Z"
    });

    const updates: Array<string | { text: string; bodyFormat?: string }> = [];
    await app.handleIncoming(
      makeMessage("/resume session-1"),
      undefined,
      async (text) => {
        updates.push(text);
      }
    );

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], {
      text: "[Claude] 2026-04-09T20:27:10.194+08:00\n\nstill replay",
      bodyFormat: "raw-text"
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("local command alias can prepend args and direct commands run unchanged", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-local-"));
  try {
    const projectDir = path.join(tmp, "project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, ".hidden"), "hidden\n");

    const app = new App({
      ...makeConfig(path.join(tmp, "bindings.json")),
      project: {
        allowedRoots: [tmp],
        defaultProject: projectDir,
        knownPaths: [],
        listMaxCount: 100
      },
      commands: {
        map: {},
        alias: {
          ll: "ls -A"
        },
        direct: ["node"]
      }
    });

    const updates: string[] = [];
    const lsResult = await app.handleIncoming(
      {
        messageId: "m-local-ls",
        chatId: "c1",
        chatType: "p2p",
        text: "/ll"
      },
      undefined,
      async (update) => {
        if (typeof update === "string") updates.push(update);
      }
    );

    assert.equal(updates.length, 1);
    assert.equal(updates[0], "Running `ll`...\n\n```text\nll\n```");
    assert.equal(typeof lsResult, "object");
    assert.equal(lsResult?.bodyFormat, "raw-text");
    assert.match(lsResult?.text || "", /\.hidden/);

    const nodeResult = await app.handleIncoming({
      messageId: "m-local-node",
      chatId: "c1",
      chatType: "p2p",
      text: `/node -e "process.stdout.write('direct')"`
    });

    assert.equal(typeof nodeResult, "object");
    assert.equal(nodeResult?.bodyFormat, "raw-text");
    assert.equal(nodeResult?.text, "direct");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("malformed local command alias is ignored with a warning", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-local-"));
  try {
    const app = new App({
      ...makeConfig(path.join(tmp, "bindings.json")),
      commands: {
        map: {},
        alias: {
          broken: "\"unterminated"
        },
        direct: []
      }
    });
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const result = (app as any).resolveLocalProjectCommand("broken");

      assert.equal(result, undefined);
      assert.equal(warnings.length, 1);
      assert.deepEqual(warnings[0], [
        "invalid local command alias ignored",
        {
          commandName: "broken",
          alias: "\"unterminated",
          parseError: "unterminated double quote"
        }
      ]);
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("signal-killed local commands are errors", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-local-"));
  try {
    const projectDir = path.join(tmp, "project");
    await mkdir(projectDir, { recursive: true });
    const app = new App({
      ...makeConfig(path.join(tmp, "bindings.json")),
      project: {
        allowedRoots: [tmp],
        defaultProject: projectDir,
        knownPaths: [],
        listMaxCount: 100
      },
      commands: {
        map: {},
        alias: {},
        direct: ["node"]
      }
    });

    const result = await app.handleIncoming({
      messageId: "m-local-node-signal",
      chatId: "c1",
      chatType: "p2p",
      text: `/node -e "process.kill(process.pid, 'SIGTERM')"`
    });

    assert.equal(typeof result, "object");
    assert.equal(result?.severity, "error");
    assert.equal(result?.bodyFormat, "raw-text");
    assert.match(result?.text || "", /^Code: SIGTERM\n\n/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
