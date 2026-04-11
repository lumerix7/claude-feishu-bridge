import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { IncomingMessage } from "../../types/domain.js";

export type { SDKSessionInfo, SessionMessage };

export interface RecentSessionMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

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
  onInit?: (sessionId: string, model: string) => void;
}

export interface ClaudeTurnOptions {
  model?: string;
  permissionMode?: string;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  effort?: string;
}

export interface RateLimitSnapshot {
  /** Fraction 0–1 (e.g. 0.91 = 91%) */
  utilization: number;
  rateLimitType?: string;
  /** Unix seconds */
  resetsAt?: number;
  capturedAt: number;
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
  getRecentSessionMessages(sessionId: string, limit: number): Promise<RecentSessionMessage[]>;
  renameSession(sessionId: string, title: string): Promise<void>;
  getVersion(): Promise<string | undefined>;
  /** Returns the actual model used in the session by reading the session transcript. */
  getSessionModel(sessionId: string): Promise<string | undefined>;
  /** Returns the last rate-limit utilization snapshot seen during any run, or undefined if none yet. */
  getRateLimitInfo(): RateLimitSnapshot | undefined;
}
