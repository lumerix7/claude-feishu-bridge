import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { IncomingMessage } from "../../types/domain.js";

export type { SDKSessionInfo, SessionMessage };

export interface ClaudeTurnResult {
  runId: string;
  sessionId?: string;
  cwd?: string;
  output: string;
  totalCostUsd?: number;
  usage?: Record<string, unknown>;
  status: "completed" | "cancelled" | "error";
}

export interface ClaudeRunHandle {
  runId: string;
  done: Promise<ClaudeTurnResult>;
}

export interface ClaudeRunHooks {
  onStatus?: (text: string) => Promise<void> | void;
  onUpdate?: (update: string) => Promise<void> | void;
}

export interface ClaudeTurnOptions {
  model?: string;
  permissionMode?: string;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  effort?: string;
}

export interface ClaudeBackend {
  readonly mode: "sdk";
  runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    project: string,
    options?: ClaudeTurnOptions,
    hooks?: ClaudeRunHooks
  ): Promise<ClaudeRunHandle>;
  stop(runId: string): Promise<boolean>;
  listSessions(dir?: string, limit?: number): Promise<SDKSessionInfo[]>;
  getSessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined>;
  getLastUserMessage(sessionId: string): Promise<string | undefined>;
  getVersion(): Promise<string | undefined>;
}
