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
  EffortLevel,
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
        ...(options?.effort ? { effort: options.effort as EffortLevel } : {}),
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
      const toolProgressEntries = new Map<string, TimelineEntry>();
      const hookEntries = new Map<string, TimelineEntry>();
      const taskEntries = new Map<string, TimelineEntry>();

      const appendAgentDelta = (delta: string): void => {
        if (!currentAgentEntry) {
          currentAgentEntry = { text: "" };
          timeline.push(currentAgentEntry);
        }
        currentAgentEntry.text += delta;
      };

      const addBlock = (text: string): TimelineEntry => {
        currentAgentEntry = null;
        const entry: TimelineEntry = { text };
        timeline.push(entry);
        return entry;
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
                const toolEntry = addBlock(renderToolBlock(block.name, input, "\ud83d\udee0\ufe0f"));
                toolProgressEntries.set(block.id, toolEntry);
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

          // Tool progress: update existing tool block in-place with elapsed time
          if (msg.type === "tool_progress") {
            const m = msg as { tool_use_id: string; tool_name: string; elapsed_time_seconds: number };
            const entry = toolProgressEntries.get(m.tool_use_id);
            const startInfo = toolStartBlocks.get(m.tool_use_id);
            if (entry && startInfo) {
              const secs = Math.round(m.elapsed_time_seconds);
              const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
              const argText = extractToolArgText(startInfo.name, startInfo.input);
              const lines = ["```text", `\u23f3 ${startInfo.name} (${elapsed})`];
              if (argText) lines.push(argText);
              lines.push("```");
              entry.text = lines.join("\n");
              emitUpdate();
            }
            continue;
          }

          // Tool use summary
          if (msg.type === "tool_use_summary") {
            const m = msg as { summary: string };
            if (m.summary?.trim()) {
              addBlock(["```text", `\ud83d\udccb ${m.summary.trim()}`, "```"].join("\n"));
              emitUpdate();
            }
            continue;
          }

          // Rate limit event
          if (msg.type === "rate_limit_event") {
            const m = msg as { rate_limit_info: { status: string; resetsAt?: number; rateLimitType?: string; utilization?: number } };
            const info = m.rate_limit_info;
            if (info.status !== "allowed") {
              const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : undefined;
              const parts = [`\u26a0\ufe0f Rate limit: ${info.status}`];
              if (info.rateLimitType) parts.push(`type: ${info.rateLimitType}`);
              if (info.utilization !== undefined) parts.push(`utilization: ${Math.round(info.utilization * 100)}%`);
              if (resetsAt) parts.push(`resets: ${resetsAt}`);
              addBlock(["```text", parts.join("\n"), "```"].join("\n"));
              emitUpdate();
            }
            continue;
          }

          // Auth status
          if (msg.type === "auth_status") {
            const m = msg as { isAuthenticating: boolean; output: string[]; error?: string };
            const lines = ["```text", `\ud83d\udd10 ${m.isAuthenticating ? "Authenticating..." : "Auth status"}`];
            if (m.output?.length) lines.push(...m.output);
            if (m.error) lines.push(`Error: ${m.error}`);
            lines.push("```");
            addBlock(lines.join("\n"));
            emitUpdate();
            continue;
          }

          // Prompt suggestion
          if (msg.type === "prompt_suggestion") {
            const m = msg as { suggestion: string };
            if (m.suggestion?.trim()) {
              addBlock(["```text", `\ud83d\udca1 Suggestion: ${m.suggestion.trim()}`, "```"].join("\n"));
              emitUpdate();
            }
            continue;
          }

          // System subtypes not covered by the init handler
          if (msg.type === "system") {
            const sys = msg as { subtype: string } & Record<string, unknown>;

            // API retry
            if (sys.subtype === "api_retry") {
              const m = sys as unknown as { attempt: number; max_retries: number; retry_delay_ms: number; error: string; error_status: number | null };
              addBlock(["```text", `\ud83d\udd04 API retry ${m.attempt}/${m.max_retries} in ${Math.round(m.retry_delay_ms / 1000)}s (${m.error}${m.error_status ? ` ${m.error_status}` : ""})`, "```"].join("\n"));
              emitUpdate();
              continue;
            }

            // Compacting status
            if (sys.subtype === "status") {
              const m = sys as unknown as { status: "compacting" | null };
              if (m.status === "compacting") {
                addBlock(["```text", "\ud83d\uddc1\ufe0f Compacting context...", "```"].join("\n"));
                emitUpdate();
              }
              continue;
            }

            // Compact boundary (compaction completed)
            if (sys.subtype === "compact_boundary") {
              const m = sys as unknown as { compact_metadata: { trigger: string; pre_tokens: number } };
              addBlock(["```text", `\u2714\ufe0f Context compacted (${m.compact_metadata.trigger}, was ${m.compact_metadata.pre_tokens.toLocaleString()} tokens)`, "```"].join("\n"));
              emitUpdate();
              continue;
            }

            // Local slash command output (/cost, /voice, etc.)
            if (sys.subtype === "local_command_output") {
              const m = sys as unknown as { content: string };
              if (m.content?.trim()) {
                addBlock(m.content.trim());
                emitUpdate();
              }
              continue;
            }

            // Session state changed — only surface requires_action
            if (sys.subtype === "session_state_changed") {
              const m = sys as unknown as { state: "idle" | "running" | "requires_action" };
              if (m.state === "requires_action") {
                addBlock(["```text", "\u26a0\ufe0f Session requires action (permission prompt pending)", "```"].join("\n"));
                emitUpdate();
              }
              continue;
            }

            // Files persisted
            if (sys.subtype === "files_persisted") {
              const m = sys as unknown as { files: { filename: string }[]; failed: { filename: string; error: string }[] };
              const lines = ["```text", "\ud83d\udcc2 Files persisted"];
              for (const f of m.files ?? []) lines.push(`  \u2713 ${f.filename}`);
              for (const f of m.failed ?? []) lines.push(`  \u274c ${f.filename}: ${f.error}`);
              lines.push("```");
              addBlock(lines.join("\n"));
              emitUpdate();
              continue;
            }

            // Hook started — create tracked entry
            if (sys.subtype === "hook_started") {
              const m = sys as unknown as { hook_id: string; hook_name: string; hook_event: string };
              const entry = addBlock(["```text", `\ud83e\uddf2 Hook: ${m.hook_name} (${m.hook_event})`, "```"].join("\n"));
              hookEntries.set(m.hook_id, entry);
              emitUpdate();
              continue;
            }

            // Hook progress — update in-place
            if (sys.subtype === "hook_progress") {
              const m = sys as unknown as { hook_id: string; hook_name: string; hook_event: string; output: string; stdout: string; stderr: string };
              const out = (m.output || m.stdout || m.stderr || "").trim();
              const entry = hookEntries.get(m.hook_id);
              const lines = ["```text", `\ud83e\uddf2 Hook: ${m.hook_name} (${m.hook_event})`];
              if (out) lines.push(out.slice(0, 1000));
              lines.push("```");
              const text = lines.join("\n");
              if (entry) {
                entry.text = text;
              } else {
                hookEntries.set(m.hook_id, addBlock(text));
              }
              emitUpdate();
              continue;
            }

            // Hook response — finalize
            if (sys.subtype === "hook_response") {
              const m = sys as unknown as { hook_id: string; hook_name: string; hook_event: string; output: string; stdout: string; stderr: string; exit_code?: number; outcome: string };
              const out = (m.output || m.stdout || m.stderr || "").trim();
              const icon = m.outcome === "success" ? "\u2705" : m.outcome === "cancelled" ? "\ud83d\uded1" : "\u274c";
              const entry = hookEntries.get(m.hook_id);
              const lines = ["```text", `${icon} Hook: ${m.hook_name} (${m.hook_event}) \u2192 ${m.outcome}${m.exit_code !== undefined ? ` [${m.exit_code}]` : ""}`];
              if (out) lines.push(out.slice(0, 1000));
              lines.push("```");
              const text = lines.join("\n");
              if (entry) {
                entry.text = text;
              } else {
                addBlock(text);
              }
              emitUpdate();
              continue;
            }

            // Task started — create tracked entry
            if (sys.subtype === "task_started") {
              const m = sys as unknown as { task_id: string; description: string; task_type?: string; workflow_name?: string };
              const label = m.workflow_name || m.task_type || "task";
              const entry = addBlock(["```text", `\ud83d\ude80 Task [${label}]: ${m.description}`, "```"].join("\n"));
              taskEntries.set(m.task_id, entry);
              emitUpdate();
              continue;
            }

            // Task progress — update in-place
            if (sys.subtype === "task_progress") {
              const m = sys as unknown as { task_id: string; description: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number }; last_tool_name?: string; summary?: string };
              const entry = taskEntries.get(m.task_id);
              const elapsed = elapsedString(m.usage.duration_ms);
              const lines = ["```text", `\u23f3 Task: ${m.description} (${elapsed}, ${m.usage.tool_uses} tools, ${m.usage.total_tokens.toLocaleString()} tokens)`];
              if (m.last_tool_name) lines.push(`Last: ${m.last_tool_name}`);
              if (m.summary) lines.push(m.summary.slice(0, 200));
              lines.push("```");
              const text = lines.join("\n");
              if (entry) {
                entry.text = text;
              } else {
                taskEntries.set(m.task_id, addBlock(text));
              }
              emitUpdate();
              continue;
            }

            // Task notification — finalize
            if (sys.subtype === "task_notification") {
              const m = sys as unknown as { task_id: string; status: string; summary: string; usage?: { total_tokens: number; tool_uses: number; duration_ms: number } };
              const icon = m.status === "completed" ? "\u2705" : m.status === "failed" ? "\u274c" : "\ud83d\uded1";
              const entry = taskEntries.get(m.task_id);
              const lines = ["```text", `${icon} Task ${m.status}: ${m.summary}`];
              if (m.usage) lines.push(`${elapsedString(m.usage.duration_ms)}, ${m.usage.tool_uses} tools, ${m.usage.total_tokens.toLocaleString()} tokens`);
              lines.push("```");
              const text = lines.join("\n");
              if (entry) {
                entry.text = text;
              } else {
                addBlock(text);
              }
              emitUpdate();
              continue;
            }

            // elicitation_complete, keep_alive, and any unknown subtypes: skip silently
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
