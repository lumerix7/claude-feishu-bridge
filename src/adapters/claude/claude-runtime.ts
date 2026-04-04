import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  query as sdkQuery,
  listSessions as sdkListSessions,
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SDKSessionInfo,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeBackend,
  ClaudeRunHandle,
  ClaudeRunHooks,
  ClaudeTurnOptions,
  ClaudeTurnResult,
} from "./backend.js";
import type { IncomingMessage } from "../../types/domain.js";
import type { AppConfig } from "../../config/env.js";

const execFileAsync = promisify(execFile);

// ---- Rendering helpers ----

function extractToolArgText(name: string, input: Record<string, unknown>): string {
  const cmd = input["command"] ?? input["cmd"] ?? input["input"];
  if (typeof cmd === "string") return cmd.trim();
  const filePath = input["file_path"] ?? input["path"] ?? input["file"];
  if (typeof filePath === "string") return String(filePath);
  const pattern = input["pattern"];
  if (typeof pattern === "string") return `pattern: ${pattern}`;
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" && v.trim().length > 0 && k !== "session_id") {
      return `${k}: ${v.trim().slice(0, 200)}`;
    }
  }
  try {
    const j = JSON.stringify(input);
    return j.length > 200 ? j.slice(0, 197) + "..." : j;
  } catch {
    return "";
  }
}

function renderToolBlock(name: string, input: Record<string, unknown>, icon: string): string {
  const argText = extractToolArgText(name, input);
  const lines = ["```text", `${icon} ${name}`];
  if (argText) lines.push(argText);
  lines.push("```");
  return lines.join("\n");
}

function renderToolResultBlock(
  content: string | { type: "text"; text: string }[] | undefined,
  isError: boolean
): string | undefined {
  let text: string;
  if (typeof content === "string") {
    text = content.trim();
  } else if (Array.isArray(content)) {
    text = content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
  } else {
    return undefined;
  }
  if (!text) return undefined;
  const maxLen = 2000;
  const display = text.length > maxLen ? text.slice(0, maxLen - 20) + "\n... (truncated)" : text;
  const icon = isError ? "\u274c" : "\u2192";
  return ["```text", `${icon} ${display.replace(/\n/g, "\n   ")}`, "```"].join("\n");
}

function renderThinkingBlock(text: string): string {
  const trimmed = text.trim().replace(/\n{3,}/g, "\n\n");
  return ["```text", "\ud83e\udde0 Thinking", trimmed, "```"].join("\n");
}

type TimelineEntry = { text: string };

function buildTimelineText(timeline: TimelineEntry[]): string {
  return timeline
    .map((e) => e.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

// ---- SDK Backend ----

export class SdkClaudeBackend implements ClaudeBackend {
  readonly mode = "sdk" as const;
  private readonly activeRuns = new Map<string, Query>();

  constructor(private readonly config: AppConfig) {}

  async runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    project: string,
    options?: ClaudeTurnOptions,
    hooks?: ClaudeRunHooks
  ): Promise<ClaudeRunHandle> {
    const runId = randomUUID();
    const permMode = (options?.permissionMode || this.config.claude.permissionMode) as PermissionMode | undefined;
    const maxBudget = options?.maxBudgetUsd ?? this.config.claude.maxBudgetUsd;

    const q = sdkQuery({
      prompt: input.text,
      options: {
        ...(sessionId ? { resume: sessionId } : {}),
        cwd: project,
        ...(permMode ? { permissionMode: permMode } : {}),
        allowDangerouslySkipPermissions: permMode === "bypassPermissions",
        ...(options?.model || this.config.claude.defaultModel
          ? { model: options?.model || this.config.claude.defaultModel }
          : {}),
        ...(maxBudget > 0 ? { maxBudgetUsd: maxBudget } : {}),
        ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
        ...(this.config.claude.claudeBin ? { pathToClaudeCodeExecutable: this.config.claude.claudeBin } : {}),
        env: {
          ...(process.env as Record<string, string>),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    });

    this.activeRuns.set(runId, q);

    const done = (async (): Promise<ClaudeTurnResult> => {
      const timeline: TimelineEntry[] = [];
      let currentAgentEntry: TimelineEntry | null = null;
      let resolvedSessionId = sessionId;
      let resolvedCwd: string | undefined;
      let totalCostUsd: number | undefined;
      let usage: Record<string, unknown> | undefined;
      let resultStatus: "completed" | "cancelled" | "error" = "completed";
      let gotResult = false;
      const toolStartBlocks = new Map<string, { name: string; input: Record<string, unknown> }>();

      const appendAgentDelta = (delta: string): void => {
        if (!currentAgentEntry) {
          currentAgentEntry = { text: "" };
          timeline.push(currentAgentEntry);
        }
        currentAgentEntry.text += delta;
      };

      const addBlock = (text: string): void => {
        currentAgentEntry = null;
        timeline.push({ text });
      };

      const runStartedAt = Date.now();
      let lastVisibleUpdateAt = runStartedAt;
      let probeEntry: TimelineEntry | undefined;

      const elapsedString = (ms: number): string => {
        const secs = Math.round(ms / 1000);
        const mins = Math.floor(secs / 60);
        return mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
      };

      const emitUpdate = (): void => {
        lastVisibleUpdateAt = Date.now();
        hooks?.onUpdate?.(buildTimelineText(timeline));
      };

      const statusIntervalMs = this.config.claude.statusIntervalMs;
      let probeTimer: ReturnType<typeof setInterval> | undefined;
      if (statusIntervalMs > 0) {
        probeTimer = setInterval(() => {
          if (Date.now() - lastVisibleUpdateAt < statusIntervalMs) return;
          const elapsed = elapsedString(Date.now() - runStartedAt);
          const block = ["```text", `\u23f3 Running\u2026 (elapsed: ${elapsed})`, "```"].join("\n");
          if (!probeEntry) {
            probeEntry = { text: block };
            timeline.push(probeEntry);
          } else {
            probeEntry.text = block;
          }
          emitUpdate();
        }, statusIntervalMs);
        (probeTimer as NodeJS.Timeout).unref();
      }

      try {
        for await (const msg of q) {
          // System init
          if (msg.type === "system" && (msg as SDKSystemMessage).subtype === "init") {
            const init = msg as SDKSystemMessage;
            resolvedSessionId = init.session_id;
            resolvedCwd = init.cwd;
            hooks?.onStatus?.(`session: ${init.session_id}, model: ${init.model}`);
            continue;
          }

          // Assistant message: text, tool_use, thinking blocks
          if (msg.type === "assistant") {
            const assistantMsg = msg as SDKAssistantMessage;
            resolvedSessionId = assistantMsg.session_id;
            for (const block of assistantMsg.message.content) {
              if (block.type === "text") {
                appendAgentDelta(block.text);
                emitUpdate();
              } else if (block.type === "tool_use") {
                const input = block.input as Record<string, unknown>;
                toolStartBlocks.set(block.id, { name: block.name, input });
                addBlock(renderToolBlock(block.name, input, "\ud83d\udee0\ufe0f"));
                emitUpdate();
              } else if (block.type === "thinking") {
                addBlock(renderThinkingBlock((block as { type: "thinking"; thinking: string }).thinking));
                emitUpdate();
              }
            }
            continue;
          }

          // User message: tool results
          if (msg.type === "user") {
            const userMsg = msg as SDKUserMessage;
            const content = Array.isArray(userMsg.message.content) ? userMsg.message.content : [];
            for (const block of content) {
              const b = block as unknown as Record<string, unknown>;
              if (b["type"] === "tool_result") {
                const startInfo = toolStartBlocks.get(b["tool_use_id"] as string);
                if (startInfo) {
                  const isError = !!b["is_error"];
                  const icon = isError ? "\u274c" : "\u2705";
                  addBlock(renderToolBlock(startInfo.name, startInfo.input, icon));
                  const outputBlock = renderToolResultBlock(
                    b["content"] as string | { type: "text"; text: string }[] | undefined,
                    isError
                  );
                  if (outputBlock) addBlock(outputBlock);
                  emitUpdate();
                }
              }
            }
            continue;
          }

          // Result
          if (msg.type === "result") {
            const resultMsg = msg as SDKResultMessage;
            gotResult = true;
            resolvedSessionId = resultMsg.session_id;
            totalCostUsd = resultMsg.total_cost_usd;
            usage = resultMsg.usage as Record<string, unknown>;
            if (resultMsg.is_error) {
              resultStatus = "error";
              const errors = (resultMsg as { errors?: string[] }).errors;
              if (errors?.length) {
                addBlock(["```text", `\u274c ${errors.join("\n")}`, "```"].join("\n"));
                emitUpdate();
              }
            } else {
              resultStatus = "completed";
            }
            continue;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addBlock(["```text", `\u274c SDK error: ${msg}`, "```"].join("\n"));
        emitUpdate();
        resultStatus = "error";
      } finally {
        this.activeRuns.delete(runId);
        if (probeTimer !== undefined) clearInterval(probeTimer);

        if (!gotResult && resultStatus !== "error") {
          resultStatus = "cancelled";
        }

        if (probeEntry) {
          const elapsed = elapsedString(Date.now() - runStartedAt);
          if (resultStatus === "completed") {
            probeEntry.text = ["```text", `\u23f1\ufe0f Completed (${elapsed})`, "```"].join("\n");
          } else if (resultStatus === "cancelled") {
            probeEntry.text = ["```text", `\ud83d\uded1 Stopped (${elapsed})`, "```"].join("\n");
          } else {
            probeEntry.text = ["```text", `\u274c Error (${elapsed})`, "```"].join("\n");
          }
          emitUpdate();
        }
      }

      return {
        runId,
        sessionId: resolvedSessionId,
        cwd: resolvedCwd,
        output: buildTimelineText(timeline),
        totalCostUsd,
        usage,
        status: resultStatus,
      };
    })();

    return { runId, done };
  }

  async stop(runId: string): Promise<boolean> {
    const q = this.activeRuns.get(runId);
    if (q) {
      await q.interrupt();
      return true;
    }
    return false;
  }

  async listSessions(dir?: string, limit = 20): Promise<SDKSessionInfo[]> {
    return sdkListSessions({ dir, limit });
  }

  async getSessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
    return sdkGetSessionInfo(sessionId);
  }

  async getLastUserMessage(sessionId: string): Promise<string | undefined> {
    try {
      const messages = await sdkGetSessionMessages(sessionId);
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.type !== "user") continue;
        const msg = m.message as { content?: unknown };
        if (typeof msg.content === "string") return msg.content;
        if (Array.isArray(msg.content)) {
          const text = msg.content
            .filter((b: unknown) => (b as { type?: string }).type === "text")
            .map((b: unknown) => (b as { text?: string }).text || "")
            .join("")
            .trim();
          if (text) return text;
        }
      }
    } catch {}
    return undefined;
  }

  async getVersion(): Promise<string | undefined> {
    const bin = this.config.claude.claudeBin;
    if (!bin) return undefined;
    try {
      const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 10_000 });
      return stdout.trim();
    } catch {
      return undefined;
    }
  }
}

export function createClaudeBackend(config: AppConfig): ClaudeBackend {
  return new SdkClaudeBackend(config);
}
