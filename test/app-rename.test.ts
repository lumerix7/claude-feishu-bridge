import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { App } from "../src/core/app.js";
import type { AppConfig } from "../src/config/env.js";
import type { ClaudeBackend } from "../src/adapters/claude/backend.js";
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
    commands: { map: {} },
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

test("rename help works regardless of -h position", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-"));
  try {
    const app = new App(makeConfig(path.join(tmp, "bindings.json")));

    for (const text of [
      "/rename -h",
      "/rename 'Review changes' -h",
      "/rename --session session-1 -h",
      "/rename -h --session session-1"
    ]) {
      const result = await app.handleIncoming(makeMessage(text));
      const rendered = typeof result === "string" ? result : result.text;
      assert.match(rendered, /^Show or set the title of the current Claude session\./);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("rename supports --session without rebinding and escapes markdown", async () => {
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
    let seenSessionId: string | undefined;
    let seenTitle: string | undefined;
    (app as any).claude = makeBackend({
      async renameSession(sessionId: string, title: string) {
        seenSessionId = sessionId;
        seenTitle = title;
      }
    });

    const result = await app.handleIncoming(makeMessage("/rename --session session-2 '# Review `changes`'"));
    const rendered = typeof result === "string" ? result : result.text;

    assert.equal(seenSessionId, "session-2");
    assert.equal(seenTitle, "# Review `changes`");
    const binding = await (app as any).store.get("c1");
    assert.equal(binding.claudeSessionId, "session-1");
    assert.match(rendered, /^- \*\*Session\*\*: `session-2`\n- \*\*Title\*\*: \\# Review \\`changes\\`$/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("rename show path supports explicit session and escapes markdown", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-"));
  try {
    const app = new App(makeConfig(path.join(tmp, "bindings.json")));
    (app as any).claude = makeBackend({
      async getSessionInfo(sessionId: string) {
        return sessionId === "session-2"
          ? ({ sessionId, customTitle: "# Review `changes`" } as any)
          : undefined;
      }
    });

    const result = await app.handleIncoming(makeMessage("/rename --session session-2"));
    const rendered = typeof result === "string" ? result : result.text;

    assert.match(rendered, /^- \*\*Session\*\*: `session-2`\n- \*\*Title\*\*: \\# Review \\`changes\\`$/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("rename without an active session renders a warning card", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-"));
  try {
    const app = new App(makeConfig(path.join(tmp, "bindings.json")));
    const result = await app.handleIncoming(makeMessage("/rename"));

    assert.equal(typeof result, "object");
    assert.equal(result?.severity, "warning");
    assert.match(result?.text ?? "", /- \*\*Warning\*\*: No active session\. Send a message or use `\/new` to start/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("session detail keeps hyphens readable while escaping markdown punctuation", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "claude-feishu-bridge-"));
  try {
    const app = new App(makeConfig(path.join(tmp, "bindings.json")));
    (app as any).claude = makeBackend({
      async getSessionInfo(sessionId: string) {
        return sessionId === "session-2"
          ? ({
              sessionId,
              cwd: "/workspace/project-a",
              customTitle: "review-since-0407",
              summary: "review-since-0407 #tag"
            } as any)
          : undefined;
      }
    });

    const result = await app.handleIncoming(makeMessage("/session session-2"));
    const rendered = typeof result === "string" ? result : result.text;

    assert.match(rendered, /- \*\*Title\*\*: review-since-0407/);
    assert.match(rendered, /- \*\*Summary\*\*: review-since-0407 \\#tag/);
    assert.doesNotMatch(rendered, /review\\-since\\-0407/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
