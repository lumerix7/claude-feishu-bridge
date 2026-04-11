import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { ClaudeBackend, ClaudeTurnOptions } from "../adapters/claude/backend.js";
import { createClaudeBackend } from "../adapters/claude/claude-runtime.js";
import { FeishuGateway } from "../adapters/feishu/feishu-gateway.js";
import { AppConfig } from "../config/env.js";
import { conversationKeyFor } from "./conversation-key.js";
import { parseCommand } from "./command-router.js";
import { BindingStore } from "../store/binding-store.js";
import { ActiveRun, IncomingMessage, OutgoingBodyFormat, OutgoingMessage, SessionBinding } from "../types/domain.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_RESUME_REPLAY_COUNT = 5;

const COMMAND_BASE_TITLES: Record<string, string> = {
  help: "Help",
  status: "Status",
  new: "New Session",
  session: "Session",
  resume: "Resume",
  stop: "Stop",
  model: "Model",
  permission: "Permission",
  project: "Project",
  feishu: "Feishu",
  log: "Log"
};

// Shell passthrough commands: title is just the bare command name (+ first arg if present)
const SHELL_COMMAND_NAMES = new Set([
  "git", "pwd",
  "ls", "cat", "head", "tail", "wc",
  "find", "rg", "tree",
  "cp", "mv", "mkdir", "touch", "ln", "rmdir", "readlink",
  "sha256sum", "tar", "trash"
]);

type AppResponse = {
  text: string;
  bodyFormat?: OutgoingBodyFormat;
  severity?: "warning" | "error";
};

class ArgCursor {
  private readonly args: string[];
  constructor(args: string[]) { this.args = [...args]; }
  peek(): string | undefined { return this.args[0]; }
  shift(): string | undefined { return this.args.shift(); }
  isEmpty(): boolean { return this.args.length === 0; }
  remaining(): string[] { return [...this.args]; }
  remainingText(): string { return this.args.join(" ").trim(); }
  takeFlag(...names: string[]): boolean {
    const index = this.args.findIndex((arg) => names.includes(arg));
    if (index < 0) return false;
    this.args.splice(index, 1);
    return true;
  }
  takeOption(...names: string[]): string | undefined {
    const index = this.args.findIndex((arg) => names.includes(arg));
    if (index < 0) return undefined;
    const value = this.args[index + 1];
    this.args.splice(index, value ? 2 : 1);
    if (!value || value.startsWith("-")) return "";
    return value;
  }
}

export class App {
  private readonly store: BindingStore;
  private readonly claude: ClaudeBackend;
  private feishu?: FeishuGateway;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly modelOverrides = new Map<string, { model?: string; effort?: string }>();
  private claudeSettingsCache: { model?: string; effortLevel?: string } | null | undefined = undefined;

  constructor(private readonly config: AppConfig) {
    this.store = new BindingStore(path.resolve(this.config.storePath));
    this.claude = createClaudeBackend(this.config);
  }

  async start(): Promise<void> {
    console.log("claude-feishu-bridge starting", {
      nodeEnv: this.config.nodeEnv,
      configPath: this.config.configPath,
      projectAllowedRoots: this.config.project.allowedRoots,
      defaultProject: this.config.project.defaultProject,
      defaultModel: this.config.claude.defaultModel || "(default)"
    });
    this.feishu = new FeishuGateway(this.config.feishu);
    await this.feishu.start(
      async (message) => {
        const parsedCommand = parseCommand(message);
        const command = parsedCommand && "args" in parsedCommand ? parsedCommand : undefined;
        const currentBinding = await this.store.get(conversationKeyFor(message));
        const msgKey = conversationKeyFor(message);
        const commandName = command?.name || ("name" in (parsedCommand || {}) ? (parsedCommand as any)?.name : undefined);
        const titleInput = command
          ? `/${command.name}${command.args.length ? " " + command.args.join(" ") : ""}`
          : message.text;
        const messageTitle = this.titleForCommand(commandName, titleInput);
        const messageTemplate = this.templateForCommand(commandName);
        try {
          let streamed = false;
          let lastUpdateText: string | undefined;
          let accumulatedStreamText = "";
          let statusChain = Promise.resolve();
          let streamingSendInFlight = false;
          let queuedStreamingSnapshot: string | undefined;
          let streamDrain = Promise.resolve();
          const streamKey = `${message.chatId}:${message.threadId || "root"}:${message.messageId}:${commandName || "claude"}`;

          const sendStatusSafely = async (update: string | AppResponse): Promise<void> => {
            statusChain = statusChain.then(async () => {
              try {
                const latestBinding = (await this.store.get(conversationKeyFor(message))) || currentBinding;
                const updateText = typeof update === "string" ? update : update.text;
                const updateBodyFormat = typeof update === "string" ? undefined : update.bodyFormat;
                await this.feishu?.send({
                  chatId: message.chatId,
                  title: messageTitle,
                  template: messageTemplate,
                  footer: await this.buildFooter(msgKey, latestBinding),
                  text: updateText,
                  replyToMessageId: message.messageId,
                  threadId: message.threadId,
                  streaming: false,
                  bodyFormat: updateBodyFormat
                });
              } catch (error) {
                console.error("failed to send Feishu update", { messageId: message.messageId, error });
              }
            });
            await statusChain;
          };

          const sendStreamSnapshot = async (snapshot: string): Promise<void> => {
            try {
              const latestBinding = (await this.store.get(conversationKeyFor(message))) || currentBinding;
              await this.feishu?.send({
                chatId: message.chatId,
                title: messageTitle,
                template: messageTemplate,
                footer: await this.buildFooter(msgKey, latestBinding),
                text: snapshot,
                replyToMessageId: message.messageId,
                threadId: message.threadId,
                streaming: true,
                streamKey,
                suppressChunkFooter: true,
                preserveStreamingPages: true
              });
              streamed = true;
              lastUpdateText = snapshot;
              accumulatedStreamText = snapshot;
            } catch (error) {
              console.error("failed to send Feishu streaming update", { messageId: message.messageId, error });
            }
          };

          const sendUpdateSafely = async (update: string): Promise<void> => {
            if (commandName) {
              await sendStatusSafely(update);
              return;
            }
            queuedStreamingSnapshot = update;
            if (streamingSendInFlight) {
              await streamDrain;
              return;
            }
            streamingSendInFlight = true;
            streamDrain = (async () => {
              while (queuedStreamingSnapshot !== undefined) {
                const snapshot = queuedStreamingSnapshot;
                queuedStreamingSnapshot = undefined;
                await sendStreamSnapshot(snapshot);
              }
              streamingSendInFlight = false;
            })();
            await streamDrain;
          };

          const result = await this.handleIncoming(message, sendUpdateSafely, sendStatusSafely);
          const text = typeof result === "string" ? result : result.text;
          const responseSeverity = typeof result === "string" ? undefined : result.severity;
          const responseBodyFormat = typeof result === "string" ? undefined : result.bodyFormat;
          await statusChain;
          await streamDrain;

          const formattedText = commandName
            ? text
            : accumulatedStreamText || text;
          const shouldFinalizeLiveStream = !commandName && streamed;

          if ((formattedText && formattedText !== lastUpdateText) || !streamed || shouldFinalizeLiveStream) {
            const latestBinding = (await this.store.get(conversationKeyFor(message))) || currentBinding;
            const finalFooter = await this.buildFooter(msgKey, latestBinding);
            const finalTemplate = responseSeverity === "error" ? "red"
              : responseSeverity === "warning" ? "yellow"
              : messageTemplate;
            await this.feishu?.send({
              chatId: message.chatId,
              title: messageTitle,
              template: finalTemplate,
              footer: finalFooter,
              text: formattedText,
              bodyFormat: responseBodyFormat,
              replyToMessageId: message.messageId,
              threadId: message.threadId,
              streaming: true,
              ...(commandName ? {} : { streamKey, finalizeStreaming: true, suppressChunkFooter: true, preserveStreamingPages: true })
            });
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : "Unknown bridge error.";
          try {
            await this.feishu?.send({
              chatId: message.chatId,
              title: messageTitle || "Bridge Error",
              template: "red",
              footer: await this.buildFooter(msgKey, currentBinding),
              text: `bridge error: ${text}`,
              replyToMessageId: message.messageId,
              threadId: message.threadId
            });
          } catch (sendError) {
            console.error("failed to send bridge error to Feishu", sendError);
          }
        }
      },
      async () => {
        await this.sendStartupReadyNotification("Reconnected", "Feishu reconnect ready notification sent");
      }
    );
    await this.sendStartupReadyNotification("Bridge Ready", "Feishu startup ready notification sent");
  }

  async handleIncoming(
    message: IncomingMessage,
    onUpdate?: (update: string) => Promise<void>,
    onStatus?: (text: string | AppResponse) => Promise<void>
  ): Promise<string | AppResponse> {
    if (message.chatType !== "p2p") {
      return "Only direct messages are supported right now.";
    }

    const parsedCommand = parseCommand(message);
    if (parsedCommand && "parseError" in parsedCommand) {
      return { text: `Parse error: ${parsedCommand.parseError}`, severity: "warning" };
    }
    const command = parsedCommand;

    if (command?.name === "help") return this.handleHelp(new ArgCursor(command.args));
    if (command?.name === "status") return this.handleStatus(message, new ArgCursor(command.args));
    if (command?.name === "new") return this.handleNew(message, new ArgCursor(command.args));
    if (command?.name === "stop") return this.handleStop(message);
    if (command?.name === "model") return this.handleModel(message, new ArgCursor(command.args));
    if (command?.name === "permission") return this.handlePermission(message, new ArgCursor(command.args));
    if (command?.name === "project") return this.handleProject(message, new ArgCursor(command.args));
    if (command?.name === "session") return this.handleSession(message, new ArgCursor(command.args));
    if (command?.name === "resume") {
      const replayStatusSink = onStatus || (onUpdate
        ? async (text: string | AppResponse) => {
            if (typeof text === "string") {
              await onUpdate(text);
            }
          }
        : undefined);
      return this.handleResume(message, new ArgCursor(command.args), replayStatusSink);
    }
    if (command?.name === "rename") return this.handleRename(message, new ArgCursor(command.args));

    // File system commands
    if (command?.name === "git") return this.handleShellCommand(message, "git", command.args, onStatus);
    if (command?.name === "pwd") return this.handlePwd(message);
    if (command?.name === "ls") return this.handleShellCommand(message, "ls", command.args, onStatus);
    if (command?.name === "cat") return this.handleShellCommand(message, "cat", command.args, onStatus);
    if (command?.name === "head") return this.handleShellCommand(message, "head", command.args, onStatus);
    if (command?.name === "tail") return this.handleShellCommand(message, "tail", command.args, onStatus);
    if (command?.name === "find") return this.handleShellCommand(message, "find", command.args, onStatus);
    if (command?.name === "rg") return this.handleShellCommand(message, "rg", command.args, onStatus);
    if (command?.name === "tree") return this.handleShellCommand(message, "tree", command.args, onStatus);
    if (command?.name === "wc") return this.handleShellCommand(message, "wc", command.args, onStatus);
    if (command?.name === "cp") return this.handleShellCommand(message, "cp", command.args, onStatus);
    if (command?.name === "mv") return this.handleShellCommand(message, "mv", command.args, onStatus);
    if (command?.name === "mkdir") return this.handleShellCommand(message, "mkdir", command.args, onStatus);
    if (command?.name === "touch") return this.handleShellCommand(message, "touch", command.args, onStatus);
    if (command?.name === "ln") return this.handleShellCommand(message, "ln", command.args, onStatus);
    if (command?.name === "rmdir") return this.handleShellCommand(message, "rmdir", command.args, onStatus);
    if (command?.name === "readlink") return this.handleShellCommand(message, "readlink", command.args, onStatus);
    if (command?.name === "sha256sum") return this.handleShellCommand(message, "sha256sum", command.args, onStatus);
    if (command?.name === "tar") return this.handleShellCommand(message, "tar", command.args, onStatus);
    if (command?.name === "trash") return this.handleShellCommand(message, "trash", command.args, onStatus);

    if (command?.name === "feishu") return this.handleFeishu(new ArgCursor(command.args));
    if (command?.name === "log") return this.handleLog(new ArgCursor(command.args));

    // Not a command — send to Claude
    return this.handleClaudeTurn(message, onUpdate, onStatus);
  }

  // ---- Helpers ----

  private renderCommandError(_title: string, error: string, usage?: string): AppResponse {
    return {
      severity: "warning",
      text: [
        `- **Error**: ${error}`,
        ...(usage ? [`- **Usage**: ${usage}`] : [])
      ].join("\n")
    };
  }

  // ---- Command handlers ----

  private handleHelp(cursor: ArgCursor): string | AppResponse {
    const rawMarkdownOnly = cursor.takeFlag("--raw-markdown");
    const text = [
      "## Core",
      "",
      "- `/help [--raw-markdown]` show commands",
      "- `/status` show current session and bridge state",
      "- `/new [-C|--cd <dir>] [-h|--help]` create and bind a fresh Claude session",
      "- `/session [<session-id>|list [options]] [-h|--help]` inspect current session, inspect a specific session, or browse recent sessions",
      "- `/resume [<session-id>|-|--last|-n <index>|list] [--messages <count>] [-C <dir>] [-h|--help]` bind a previous session",
      "- `/rename [<name>] [-h|--help]` show or set the current session title",
      "- `/stop` stop the current active run",
      "",
      "## Claude",
      "",
      "- `/model [<name>|list] [-e|--effort <level>] [-h|--help]` show or set the model and effort level",
      "- `/permission [<mode>] [-h|--help]` show or set the permission mode",
      "  - modes: `bypassPermissions` `acceptEdits` `auto` `dontAsk` `plan` `default`",
      "",
      "## Project",
      "",
      "- `/project [list|bind [<path>|-n <index>|-m <path>]|unbind] [-h|--help]` show or manage the bound project",
      "- `/git [args...]` run `git` directly in the current bound project",
      "- `/pwd` show the current bound project directory",
      "- `/ls [args...]` `/cat <file>` `/head` `/tail` file inspection tools",
      "- `/find [args...]` `/rg [args...]` `/tree [args...]` search and tree tools",
      "- `/cp` `/mv` `/mkdir` `/touch` `/ln` `/rmdir` `/tar` `/trash` file management",
      "",
      "## Diagnostics",
      "",
      "- `/feishu [ws|doctor]` show Feishu websocket and outbound send diagnostics",
      "- `/log [-n <count>]` show recent bridge service logs from systemd journal",
      "",
      "## Notes",
      "",
      "- Add `--raw-markdown` to `/help` or `/session` to return fenced source markdown instead of rendered markdown."
    ].join("\n");
    return this.withBodyFormat(text, rawMarkdownOnly ? "raw-markdown" : undefined);
  }


  private async handleStatus(message: IncomingMessage, cursor: ArgCursor): Promise<string> {
    const key = conversationKeyFor(message);
    const binding = await this.store.get(key);
    const activeRun = this.activeRuns.get(key);

    const [version, project, modelOpts] = await Promise.all([
      this.claude.getVersion(),
      this.effectiveProject(binding),
      this.resolveModelOptions(key),
    ]);

    const lines: string[] = [
      `**Claude Code**: ${version || "unknown"}`,
      `**Model**: ${modelOpts.model || "(default)"}`,
      `**Effort**: ${modelOpts.effort || "(default)"}`,
      `**Permission mode**: ${binding?.permissionMode || this.config.claude.permissionMode}`,
      `**Project**: \`${project}\``,
    ];
    if (binding?.claudeSessionId) {
      lines.push(`**Session**: \`${binding.claudeSessionId}\``);
    } else {
      lines.push("**Session**: (none — send a message to start)");
    }
    if (activeRun) {
      lines.push(`**Active run**: ${activeRun.runId} (${activeRun.status})`);
    }
    lines.push(`**Conversation**: \`${key}\``);
    return lines.join("\n");
  }

  private newHelpText(): string {
    return [
      "Create and bind a fresh Claude session for the current bound project.",
      "",
      "## Usage",
      "",
      "- `/new` — create a new session for the current project",
      "- `/new -C|--cd <dir>` — switch project then create a new session",
      "- `/new -h|--help` — show this help",
      "",
      "## Options",
      "",
      "- `-C, --cd <dir>` switch the conversation project before creating the new session",
      "- `-h, --help` show new-session help"
    ].join("\n");
  }

  private async handleNew(message: IncomingMessage, cursor: ArgCursor): Promise<string | AppResponse> {
    const key = conversationKeyFor(message);

    if (cursor.peek() === "-h" || cursor.peek() === "--help") return this.newHelpText();

    const dirArg = cursor.takeOption("-C", "--cd");

    if (!cursor.isEmpty()) {
      return this.renderCommandError("New Session", `unsupported argument \`${cursor.peek()}\``, "`/new [-C|--cd <dir>] [-h|--help]`");
    }

    const binding = await this.store.get(key);
    const project = dirArg
      ? this.resolveProject(dirArg)
      : await this.effectiveProject(binding);

    if (!this.isAllowedProject(project)) {
      return this.renderCommandError("New Session", `path not in allowed roots: \`${project}\``, "`/new [-C|--cd <dir>]`");
    }

    const now = new Date().toISOString();
    await this.store.put({
      conversationKey: key,
      claudeSessionId: undefined,
      project,
      createdAt: now,
      updatedAt: now
    });
    return `New session ready. Project: \`${project}\`\nSend a message to start chatting with Claude.`;
  }

  private async handleStop(message: IncomingMessage): Promise<string | AppResponse> {
    const key = conversationKeyFor(message);
    const activeRun = this.activeRuns.get(key);
    if (!activeRun) {
      return { text: "No active run to stop.", severity: "warning" };
    }
    const stopped = await this.claude.stop(activeRun.runId);
    if (stopped) {
      this.activeRuns.delete(key);
      return "Run stopped.";
    }
    return { text: "Failed to stop run.", severity: "warning" };
  }

  private modelHelpText(): string {
    return [
      "Show or change the model and effort level for this conversation.",
      "",
      "## Usage",
      "",
      "- `/model` — show current model and effort",
      "- `/model <name>` — set model (e.g. `sonnet`, `opus`, `claude-sonnet-4-6`)",
      "- `/model list` — list available models",
      "- `/model --effort <level>` — set effort level",
      "- `/model <name> --effort <level>` — set both at once",
      "",
      "## Options",
      "",
      "- `-e, --effort <level>` set effort: `low`, `medium`, `high` (default), `max`",
      "- `-h, --help` show this help",
    ].join("\n");
  }

  private static readonly KNOWN_MODELS: {
    alias: string; model: string; reasoning: string; input: string;
    personality: string; default?: boolean; hidden?: boolean; upgrade?: string; notes?: string;
  }[] = [
    { alias: "opus", model: "claude-opus-4-6", reasoning: "max", input: "200k", personality: "Thorough, precise", default: false, notes: "Most capable" },
    { alias: "sonnet", model: "claude-sonnet-4-6", reasoning: "high", input: "200k", personality: "Balanced", default: true, notes: "Best value" },
    { alias: "haiku", model: "claude-haiku-4-5-20251001", reasoning: "medium", input: "200k", personality: "Fast, concise", notes: "Fastest" },
  ];

  private async handleModel(message: IncomingMessage, cursor: ArgCursor): Promise<string | AppResponse> {
    const key = conversationKeyFor(message);
    const binding = await this.store.get(key);

    if (cursor.peek() === "-h" || cursor.peek() === "--help") {
      return this.modelHelpText();
    }

    if (cursor.peek() === "list") {
      cursor.shift();
      if (!cursor.isEmpty()) {
        return this.renderCommandError("Model", `unexpected argument: ${cursor.peek()!}`, "/model list");
      }
      const { model: currentModel } = await this.resolveModelOptions(key);
      const header = "| # | Model | Reasoning | Input | Personality | Default | Upgrade | Notes |";
      const sep    = "|---|-------|-----------|-------|-------------|---------|---------|-------|";
      const rows = App.KNOWN_MODELS.map((m, i) => {
        const isCurrent = currentModel === m.alias || currentModel === m.model;
        const num = `${i + 1}`;
        const name = isCurrent ? `\`${m.alias}\` \`current\`` : m.alias;
        const def = m.default ? "✓" : "";
        const upgrade = m.upgrade || "";
        const notes = m.notes || "";
        return `| ${num} | ${name} | ${m.reasoning} | ${m.input} | ${m.personality} | ${def} | ${upgrade} | ${notes} |`;
      });
      return [header, sep, ...rows].join("\n");
    }

    const VALID_EFFORTS = ["low", "medium", "high", "max"];
    let modelName: string | undefined;
    let effort: string | undefined;

    while (!cursor.isEmpty()) {
      const tok = cursor.peek()!;
      if (tok === "-e" || tok === "--effort") {
        cursor.shift();
        const level = cursor.shift();
        if (!level) {
          return this.renderCommandError("Model", "missing effort level", "/model --effort <low|medium|high|max>");
        }
        if (!VALID_EFFORTS.includes(level)) {
          return this.renderCommandError("Model", `invalid effort level: ${level}`, `valid: ${VALID_EFFORTS.join(", ")}`);
        }
        effort = level;
      } else if (tok.startsWith("-")) {
        return this.renderCommandError("Model", `unknown option: ${tok}`, "/model -h");
      } else {
        if (modelName) {
          return this.renderCommandError("Model", `unexpected argument: ${tok}`, "/model [<name>] [-e|--effort <level>]");
        }
        modelName = cursor.shift()!;
      }
    }

    // No args → show current resolved values
    if (!modelName && !effort) {
      const opts = await this.resolveModelOptions(key);
      return `**Model**: ${opts.model || "(default)"}\n**Effort**: ${opts.effort || "(default)"}`;
    }

    // Apply changes — kept in memory only, not persisted to bindings store
    const lines: string[] = [];
    const existing = this.modelOverrides.get(key) || {};
    this.modelOverrides.set(key, {
      ...existing,
      ...(modelName ? { model: modelName } : {}),
      ...(effort ? { effort } : {}),
    });
    if (modelName) lines.push(`Model set to: **${modelName}**`);
    if (effort) lines.push(`Effort set to: **${effort}**`);
    return lines.join("\n");
  }

  private permissionHelpText(): string {
    return [
      "Show or set the permission mode for this conversation.",
      "",
      "## Usage",
      "",
      "- `/permission` — show current permission mode",
      "- `/permission <mode>` — set permission mode",
      "- `/permission -h|--help` — show this help",
      "",
      "## Options",
      "",
      "- `-h, --help` show this help",
      "",
      "## Modes",
      "",
      "- `bypassPermissions` skip all permission checks (sandboxed environments only)",
      "- `acceptEdits` auto-accept file edits",
      "- `auto` auto-approve where safe",
      "- `dontAsk` never prompt for permission",
      "- `plan` read-only planning mode",
      "- `default` restore Claude's default permission behaviour",
    ].join("\n");
  }

  private async handlePermission(message: IncomingMessage, cursor: ArgCursor): Promise<string | AppResponse> {
    if (cursor.peek() === "-h" || cursor.peek() === "--help") {
      return this.permissionHelpText();
    }

    const key = conversationKeyFor(message);
    const binding = await this.store.get(key);
    const mode = cursor.remainingText();

    if (!mode) {
      return `**Current permission mode**: ${binding?.permissionMode || this.config.claude.permissionMode}`;
    }

    const validModes = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];
    if (!validModes.includes(mode)) {
      return this.renderCommandError("Permission", `invalid mode: ${mode}`, `valid: ${validModes.join(", ")}`);
    }

    const now = new Date().toISOString();
    if (binding) {
      binding.permissionMode = mode;
      binding.updatedAt = now;
      await this.store.put(binding);
    } else {
      await this.store.put({
        conversationKey: key,
        project: this.config.project.defaultProject,
        permissionMode: mode,
        createdAt: now,
        updatedAt: now
      });
    }
    return `Permission mode set to: **${mode}**`;
  }

  private projectHelpText(): string {
    return [
      "Inspect the current bound project, browse known projects, or bind one.",
      "",
      "## Usage",
      "",
      "- `/project` — show the current bound project",
      "- `/project list` — browse known projects",
      "- `/project bind [<path>|-n <index>|-m|--mkdir <path>]` — bind a project",
      "- `/project unbind` — remove the project binding for this conversation",
      "- `/project -h|--help` — show this help",
      "",
      "## Options",
      "",
      "### List",
      "",
      "- `list` browse known projects (indexed for use with `bind -n`)",
      "",
      "### Bind",
      "",
      "- `bind <path>` bind a project path to this conversation",
      "- `bind -n <index>` bind a project from the current `/project list` ordering",
      "- `bind -m, --mkdir <path>` create the directory before binding",
      "",
      "### Unbind",
      "",
      "- `unbind` remove the project binding for this conversation",
      "",
      "### General",
      "",
      "- `-h, --help` show project help",
      "",
      "## Examples",
      "",
      "- `/project`",
      "- `/project list`",
      "- `/project bind /path/to/my-project`",
      "- `/project bind -n 2`",
      "- `/project bind --mkdir /path/to/new-project`",
      "- `/project unbind`"
    ].join("\n");
  }

  private async handleProject(message: IncomingMessage, cursor: ArgCursor): Promise<string | AppResponse> {
    const key = conversationKeyFor(message);
    const sub = cursor.shift();

    if (sub === "-h" || sub === "--help") return this.projectHelpText();

    if (sub === "list") {
      if (cursor.peek() === "-h" || cursor.peek() === "--help") return this.projectHelpText();
      if (!cursor.isEmpty()) {
        return this.renderCommandError("Project", `unsupported project list argument \`${cursor.peek()}\``, "`/project list`");
      }
      const [bindings, currentBinding, sessions] = await Promise.all([
        this.store.list(),
        this.store.get(key),
        this.claude.listSessions(undefined, 50).catch(() => [])
      ]);
      const currentProject = await this.effectiveProject(currentBinding);

      // Project metadata map: path → { updatedAt, source }
      // "bound" = has explicit store binding; "session" = seen in Claude session only
      type ProjectMeta = { updatedAt?: string; source: "bound" | "session" };
      const byProject = new Map<string, ProjectMeta>();

      // Populate from store bindings (authoritative, with timestamp)
      for (const b of bindings) {
        if (!b.project || this.isStaleProject(b.project)) continue;
        const existing = byProject.get(b.project);
        if (!existing || (b.updatedAt > (existing.updatedAt || ""))) {
          byProject.set(b.project, { updatedAt: b.updatedAt, source: "bound" });
        }
      }

      // Enrich from Claude sessions (for projects with no explicit binding)
      for (const s of sessions) {
        if (!s.cwd || !this.isAllowedProject(s.cwd)) continue;
        if (!byProject.has(s.cwd)) {
          const sessionUpdatedAt = s.lastModified ? new Date(s.lastModified).toISOString() : undefined;
          byProject.set(s.cwd, { updatedAt: sessionUpdatedAt, source: "session" });
        }
      }

      if (byProject.size === 0) return "No projects found.";

      const projects = await this.listProjects(currentProject, byProject.keys());

      const escapeCell = (s: string) => s.replace(/\|/g, "\\|");
      const header = "| # | Name | Flags | Updated | Path |";
      const divider = "| --- | --- | --- | --- | --- |";
      const rows = projects.map((p, i) => {
        const meta = byProject.get(p);
        const name = escapeCell(path.basename(p));
        const flags = [
          p === currentProject ? "`current`" : meta?.source === "bound" ? "bound" : "",
          this.isAllowedProject(p) ? "trusted" : "",
          meta?.source === "session" ? "session" : ""
        ].filter(Boolean).join(", ");
        const updated = meta?.updatedAt ? meta.updatedAt.slice(0, 19).replace("T", " ") : "-";
        return `| ${i + 1} | ${name} | ${flags} | ${updated} | \`${escapeCell(p)}\` |`;
      });

      return [header, divider, ...rows].join("\n");
    }

    if (sub === "bind") {
      if (cursor.peek() === "-h" || cursor.peek() === "--help") return this.projectHelpText();
      const mkdir = cursor.takeFlag("-m") || cursor.takeFlag("--mkdir");
      const indexArg = cursor.takeOption("-n");

      let project: string;
      if (indexArg !== undefined) {
        if (!cursor.isEmpty()) {
          return this.renderCommandError("Project", `unsupported bind argument \`${cursor.peek()}\``, "`/project bind -n <index>`");
        }
        const index = Number(indexArg);
        if (!indexArg || !Number.isInteger(index) || index < 1) {
          return this.renderCommandError("Project", "invalid index — must be a positive integer", "`/project bind -n <index>`");
        }
        const [currentBind, sessions] = await Promise.all([
          this.store.get(key),
          this.claude.listSessions(undefined, 50).catch(() => [])
        ]);
        const sessionPaths = sessions.map((s) => s.cwd).filter((c): c is string => !!c && this.isAllowedProject(c));
        const currentBind2 = currentBind;
        const projects = await this.listProjects(await this.effectiveProject(currentBind2), sessionPaths);
        const selected = projects[index - 1];
        if (!selected) {
          return this.renderCommandError("Project", `index ${index} out of range (1–${projects.length})`, "`/project list`");
        }
        project = selected;
      } else {
        const dirArg = cursor.remainingText();
        if (!dirArg) {
          return this.renderCommandError("Project", "missing path", "`/project bind <path>`");
        }
        project = this.resolveProject(dirArg);
      }

      if (!this.isAllowedProject(project)) {
        return this.renderCommandError("Project", `path not in allowed roots: \`${project}\``, "`/project bind <path>`");
      }

      if (mkdir) {
        await execFileAsync("mkdir", ["-p", project]);
      }

      const binding = await this.store.get(key);
      const now = new Date().toISOString();
      if (binding) {
        binding.project = project;
        binding.updatedAt = now;
        await this.store.put(binding);
      } else {
        await this.store.put({ conversationKey: key, project, createdAt: now, updatedAt: now });
      }
      return `Project bound: \`${project}\``;
    }

    if (sub === "unbind") {
      if (cursor.peek() === "-h" || cursor.peek() === "--help") return this.projectHelpText();
      if (!cursor.isEmpty()) {
        return this.renderCommandError("Project", `unsupported unbind argument \`${cursor.peek()}\``, "`/project unbind`");
      }
      const binding = await this.store.get(key);
      if (!binding) return "No binding to remove.";
      binding.project = this.config.project.defaultProject;
      binding.claudeSessionId = undefined;
      binding.updatedAt = new Date().toISOString();
      await this.store.put(binding);
      return `Unbound. Reset to default project: \`${this.config.project.defaultProject}\``;
    }

    if (sub !== undefined) {
      return this.renderCommandError("Project", `unknown subcommand \`${sub}\``, "`/project [list|bind|unbind] [-h|--help]`");
    }

    // Default: show current
    const binding = await this.store.get(key);
    return `**Project**: \`${await this.effectiveProject(binding)}\``;
  }

  private sessionHelpText(): string {
    return [
      "# Session",
      "",
      "Inspect the current bound session, inspect one specific Claude Code session, or browse recent sessions.",
      "",
      "## Usage",
      "",
      "### `/session [<session-id>]` - Show session details.",
      "",
      "- `/session` Show the current bound session for this conversation.",
      "- `<session-id>` Show one specific session id without rebinding.",
      "",
      "### `/session list [options]` - List recent sessions.",
      "",
      "- `/session list` Browse recent sessions instead of rendering one session detail view.",
      "",
      "#### Options",
      "",
      "- `-n <count>` Limit the number of sessions shown (default: `20`).",
      "- `--all` Expand browsing beyond the current project.",
      "- `--project <path>` Scope the list to one specific project path.",
      "",
      "### General",
      "",
      "- `--raw-markdown` Return fenced source markdown instead of rendered markdown.",
      "- `-h, --help` Show session help.",
      "",
      "## Examples",
      "",
      "- `/session` - show the current bound session for this conversation",
      "- `/session <session-id>` - inspect one specific session without rebinding",
      "- `/session list` - browse recent sessions for the current project"
    ].join("\n");
  }

  private renameHelpText(): string {
    return [
      "Show or set the title of the current Claude session.",
      "",
      "## Usage",
      "",
      "- `/rename` — show the current session title",
      "- `/rename <name>` — set a custom title for the current session",
      "- `/rename <session-id> <name>` — set a custom title for a specific session",
      "- `/rename -h|--help` — show this help",
      "",
      "## Options",
      "",
      "- `-h, --help` show rename help",
      "",
      "## Notes",
      "",
      "The title appears in `/session list` and in the Claude Code session history.",
      "Session IDs can be found with `/session list`."
    ].join("\n");
  }

  private async handleRename(message: IncomingMessage, cursor: ArgCursor): Promise<string | AppResponse> {
    const key = conversationKeyFor(message);

    const tok = cursor.peek();
    if (tok === "-h" || tok === "--help") return this.renameHelpText();

    const binding = await this.store.get(key);
    if (!binding?.claudeSessionId) {
      return "No active session. Send a message or use `/new` to start.";
    }

    if (cursor.isEmpty()) {
      // Show current title
      const info = await this.claude.getSessionInfo(binding.claudeSessionId).catch(() => undefined);
      if (!info) return `**Session**: \`${binding.claudeSessionId}\`\n**Title**: (none)`;
      const title = info.customTitle || info.summary || "(none)";
      return [
        `**Session**: \`${binding.claudeSessionId}\``,
        `**Title**: ${info.customTitle ? `_${info.customTitle}_` : title}`,
      ].join("\n");
    }

    // Collect all remaining tokens as parts of the name (or session-id + name)
    const args: string[] = [];
    while (!cursor.isEmpty()) {
      const t = cursor.shift();
      if (t) args.push(t);
    }

    // Disambiguate: if first token looks like a UUID, treat as <session-id> <name>
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let sessionId = binding.claudeSessionId;
    let name: string;
    if (args.length >= 2 && UUID_RE.test(args[0]!)) {
      sessionId = args[0]!;
      name = args.slice(1).join(" ").trim();
    } else {
      name = args.join(" ").trim();
    }

    if (!name) {
      return this.renderCommandError("Rename", "missing title", "/rename <name>");
    }

    try {
      await this.claude.renameSession(sessionId, name);
      return `Renamed \`${sessionId}\` → _${name}_`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.renderCommandError("Rename", msg);
    }
  }

  private async handleSession(message: IncomingMessage, cursor: ArgCursor): Promise<string | AppResponse> {
    const key = conversationKeyFor(message);
    const rawMarkdownOnly = cursor.takeFlag("--raw-markdown");
    const bodyFormat: OutgoingBodyFormat | undefined = rawMarkdownOnly ? "raw-markdown" : undefined;
    const help = cursor.takeFlag("-h", "--help");
    const sub = cursor.shift();
    if (help || sub === "-h" || sub === "--help") {
      return this.withBodyFormat(this.sessionHelpText(), bodyFormat);
    }
    if (sub === "list") {
      const allProjects = cursor.takeFlag("--all");
      const projectArg = cursor.takeOption("--project");
      const countRaw = cursor.takeOption("-n");
      const limit = countRaw ? Math.max(1, Math.min(100, Number(countRaw) || 20)) : 20;

      if (!cursor.isEmpty()) {
        const leftover = cursor.peek()!;
        return leftover.startsWith("/") || (!leftover.startsWith("-") && leftover.includes("/"))
          ? this.renderCommandError("Session", "use `--project <path>` to filter sessions by project path", "`/session list [--project <path>] [-n <count>] [--all]`")
          : this.renderCommandError("Session", `unsupported session list argument \`${leftover}\``, "`/session list [-n <count>] [--all] [--project <path>]`");
      }

      const binding = await this.store.get(key);
      const projectDir = projectArg || (allProjects ? undefined : (binding?.project || undefined));

      const [sessions, allBindings] = await Promise.all([
        this.claude.listSessions(projectDir, limit),
        this.store.list()
      ]);
      if (sessions.length === 0) return "No sessions.";

      const currentSessionId = (await this.store.get(key))?.claudeSessionId;
      const boundIds = new Set(allBindings.map((b) => b.claudeSessionId).filter(Boolean));

      // Sort: current first, then project asc, then updated desc
      sessions.sort((a, b) => {
        const aCur = a.sessionId === currentSessionId ? 0 : 1;
        const bCur = b.sessionId === currentSessionId ? 0 : 1;
        if (aCur !== bCur) return aCur - bCur;
        const aProj = a.cwd || "";
        const bProj = b.cwd || "";
        if (aProj !== bProj) return aProj.localeCompare(bProj);
        const aTime = a.lastModified ? new Date(a.lastModified).getTime() : 0;
        const bTime = b.lastModified ? new Date(b.lastModified).getTime() : 0;
        return bTime - aTime;
      });

      // Fetch last user message for each session in parallel
      const lastMessages = await Promise.all(
        sessions.map((s) => this.claude.getLastUserMessage(s.sessionId).catch(() => undefined))
      );

      const escapeCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const header = "| # | Project | Updated | Session | Last message | Name | Summary | Flags |";
      const divider = "| --- | --- | --- | --- | --- | --- | --- | --- |";
      const rows = sessions.map((s, i) => {
        const isCurrent = s.sessionId === currentSessionId;
        const project = s.cwd || "-";
        const updated = s.lastModified
          ? new Date(s.lastModified).toISOString().slice(0, 19).replace("T", " ")
          : "-";
        const lastMsg = lastMessages[i] ? escapeCell(lastMessages[i]!) : "-";
        const name = s.customTitle ? escapeCell(s.customTitle) : "-";
        const summary = escapeCell(s.summary || s.firstPrompt || "(no preview)");
        const flags = [
          isCurrent ? "`current`" : "",
          boundIds.has(s.sessionId) && !isCurrent ? "bound" : "",
          s.tag ? `\`${s.tag}\`` : ""
        ].filter(Boolean).join(" ");
        return `| ${i + 1} | ${project} | ${updated} | ${s.sessionId} | ${lastMsg} | ${name} | ${summary} | ${flags || "-"} |`;
      });

      return this.withBodyFormat([header, divider, ...rows].join("\n"), bodyFormat);
    }
    if (sub && sub.startsWith("-")) {
      return this.withBodyFormat(
        this.renderCommandError("Session", `unsupported bridge option \`${sub}\``, "`/session [<session-id>|list [options]|-h]`"),
        bodyFormat
      );
    }
    if (sub) {
      if (!cursor.isEmpty()) {
        return this.withBodyFormat(
          this.renderCommandError("Session", `unsupported session argument \`${cursor.peek()}\``, "`/session <session-id> [--raw-markdown]`"),
          bodyFormat
        );
      }
      const [sessionInfo, lastMessage] = await Promise.all([
        this.claude.getSessionInfo(sub).catch(() => undefined),
        this.claude.getLastUserMessage(sub).catch(() => undefined)
      ]);
      if (!sessionInfo) {
        return this.withBodyFormat(
          this.renderCommandError("Session", `session not found: \`${sub}\``),
          bodyFormat
        );
      }
      const binding = await this.store.get(key);
      const currentProject = await this.effectiveProject(binding);
      const sessionProject = sessionInfo.cwd;
      const canUseSessionProject = Boolean(sessionProject && this.isAllowedProject(sessionProject));
      const resolvedProject = canUseSessionProject ? sessionProject! : currentProject;
      const leadingLines: string[] = [];
      if (sessionProject && !canUseSessionProject) {
        leadingLines.push(`- **Warning**: session cwd \`${sessionProject}\` outside allowed roots — kept current project`);
      }
      const text = this.renderSessionDetailText({
        sessionId: sub,
        project: resolvedProject,
        updatedAt: undefined,
        sessionInfo,
        lastMessage: lastMessage || undefined,
        flags: binding?.claudeSessionId === sub ? ["`current`", "bound"] : [],
        leadingLines
      });
      return this.withBodyFormat(text, bodyFormat);
    }
    const binding = await this.store.get(key);
    if (!binding?.claudeSessionId) {
      return this.withBodyFormat("No active session. Send a message or use `/new` to start.", bodyFormat);
    }
    const [sessionInfo, lastMessage] = await Promise.all([
      this.claude.getSessionInfo(binding.claudeSessionId).catch(() => undefined),
      this.claude.getLastUserMessage(binding.claudeSessionId).catch(() => undefined)
    ]);
    const text = this.renderSessionDetailText({
      sessionId: binding.claudeSessionId,
      project: binding.project,
      updatedAt: binding.updatedAt,
      sessionInfo,
      lastMessage: lastMessage || undefined,
      flags: ["`current`", "bound"]
    });
    return this.withBodyFormat(text, bodyFormat);
  }

  private resumeHelpText(): string {
    return [
      "Resume a session.",
      "",
      "## Usage",
      "",
      "### `/resume <session-id>|[options]` - Resume a session.",
      "",
      "- `<session-id>` Resume one specific session id.",
      "",
      "#### Options",
      "",
      "- `-, --last` Resume the most recent session in the current scope.",
      "- `-n <index>` Resume the Nth session from the current `/session list` ordering.",
      `- ` + "`--messages <count>`" + ` Append the last ` + `\`${DEFAULT_RESUME_REPLAY_COUNT}\`` + ` messages by default after a successful session change.`,
      "- `-C, --cd <dir>` Resume while keeping the conversation project in that directory.",
      "",
      "### `/resume list [options]` - List resumable sessions.",
      "",
      "- `/resume list` Show resumable sessions instead of rebinding.",
      "",
      "#### Options",
      "",
      "- `--all` Expand list beyond the current project.",
      "- `--project <path>` Scope list to one project path.",
      "",
      "### General",
      "",
      "- `-h, --help` Show resume help.",
      "",
      "## Examples",
      "",
      "- `/resume <session-id>` - resume one specific session",
      "- `/resume -` - resume the most recent session in the current scope"
    ].join("\n");
  }

  private async handleResume(
    message: IncomingMessage,
    cursor: ArgCursor,
    onStatus?: (text: string | AppResponse) => Promise<void>
  ): Promise<string | AppResponse> {
    const key = conversationKeyFor(message);

    const help = cursor.takeFlag("-h", "--help");
    const cdArg = cursor.takeOption("-C", "--cd");
    if (cdArg === "") {
      return this.renderCommandError(
        "Resume",
        "missing value for `-C|--cd <dir>`",
        "`/resume [<session-id>|-|--last|-n <index>] [--messages <count>] [-C|--cd <dir>]`"
      );
    }
    const replayMessagesArg = cursor.takeOption("--messages");
    if (replayMessagesArg === "") {
      return this.renderCommandError(
        "Resume",
        "missing value for `--messages <count>`",
        "`/resume [<session-id>|-|--last|-n <index>] [--messages <count>] [-C|--cd <dir>]`"
      );
    }
    let replayMessages = DEFAULT_RESUME_REPLAY_COUNT;
    if (replayMessagesArg !== undefined) {
      const parsed = Number(replayMessagesArg);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return this.renderCommandError(
          "Resume",
          "invalid message replay count",
          "`/resume [<session-id>|-|--last|-n <index>] [--messages <count>]`"
        );
      }
      replayMessages = parsed;
    }

    if (help) return this.resumeHelpText();

    const allProjects = cursor.takeFlag("--all");
    const projectArg = cursor.takeOption("--project");
    if (projectArg === "") {
      return this.renderCommandError("Resume", "missing value for `--project <path>`", "`/resume list [--all] [--project <path>]`");
    }
    const wantsList = cursor.peek() === "list";
    if (projectArg && !wantsList) {
      return this.renderCommandError(
        "Resume",
        "use `--project <path>` with `/resume list`, or use `-C|--cd <dir>` to switch project while resuming",
        "`/resume list [--project <path>]`"
      );
    }
    if (allProjects && !wantsList) {
      return this.renderCommandError(
        "Resume",
        "use `--all` with `/resume list` to browse across projects, then resume by session id",
        "`/resume list --all`"
      );
    }

    if (wantsList) {
      cursor.shift();
      if (replayMessagesArg !== undefined) {
        return this.renderCommandError(
          "Resume",
          "use `--messages <count>` only when actually resuming a session, not with `list`",
          "`/resume [<session-id>|-|--last|-n <index>] [--messages <count>]`"
        );
      }
      if (!cursor.isEmpty()) {
        return this.renderCommandError("Resume", `unsupported argument \`${cursor.peek()}\``, "`/resume list [--all] [--project <path>]`");
      }
      const binding = await this.store.get(key);
      const currentProject = await this.effectiveProject(binding);
      const projectDir = projectArg || (allProjects ? undefined : currentProject);
      const [sessions, allBindings] = await Promise.all([
        this.claude.listSessions(projectDir, 20),
        this.store.list()
      ]);
      if (sessions.length === 0) return "No sessions.";
      const currentSessionId = binding?.claudeSessionId;
      const boundIds = new Set(allBindings.map((b) => b.claudeSessionId).filter(Boolean));
      // Sort: current first, then project asc, then updated desc
      sessions.sort((a, b) => {
        const aCur = a.sessionId === currentSessionId ? 0 : 1;
        const bCur = b.sessionId === currentSessionId ? 0 : 1;
        if (aCur !== bCur) return aCur - bCur;
        const aProj = a.cwd || "";
        const bProj = b.cwd || "";
        if (aProj !== bProj) return aProj.localeCompare(bProj);
        const aTime = a.lastModified ? new Date(a.lastModified).getTime() : 0;
        const bTime = b.lastModified ? new Date(b.lastModified).getTime() : 0;
        return bTime - aTime;
      });
      const lastMessages = await Promise.all(
        sessions.map((s) => this.claude.getLastUserMessage(s.sessionId).catch(() => undefined))
      );
      const escapeCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const header = "| # | Project | Updated | Session | Last message | Name | Summary | Branch | Flags |";
      const divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
      const rows = sessions.map((s, i) => {
        const isCurrent = s.sessionId === currentSessionId;
        const project = s.cwd || "-";
        const updated = s.lastModified ? new Date(s.lastModified).toISOString().slice(0, 19).replace("T", " ") : "-";
        const lastMsg = lastMessages[i] ? escapeCell(lastMessages[i]!) : "-";
        const name = s.customTitle ? escapeCell(s.customTitle) : "-";
        const summary = escapeCell(s.summary || s.firstPrompt || "(no preview)");
        const branch = s.gitBranch ? `\`${s.gitBranch}\`` : "-";
        const flags = [
          isCurrent ? "`current`" : "",
          boundIds.has(s.sessionId) && !isCurrent ? "bound" : "",
          s.tag ? `\`${s.tag}\`` : ""
        ].filter(Boolean).join(" ");
        return `| ${i + 1} | ${project} | ${updated} | ${s.sessionId} | ${lastMsg} | ${name} | ${summary} | ${branch} | ${flags || "-"} |`;
      });
      return [header, divider, ...rows].join("\n");
    }

    let sessionId: string | undefined;
    let wantsLast = false;

    if (cursor.peek() === "--last") {
      cursor.shift();
      wantsLast = true;
    }
    if (cursor.peek() === "-") {
      cursor.shift();
      wantsLast = true;
    }
    if ((cursor.peek() || "").startsWith("-") && cursor.peek() !== "-n") {
      return this.renderCommandError(
        "Resume",
        `unsupported bridge option \`${cursor.peek()}\``,
        "`/resume [<session-id>|-|--last|-n <index>|list]`"
      );
    }
    const indexArg = cursor.takeOption("-n");
    if (cursor.isEmpty() && !wantsLast && indexArg === undefined) {
      return {
        severity: "warning",
        text: [
          "- **Error**: pick a session explicitly, or use `-` to resume the most recent session",
          "- **Usage**: `/resume [<session-id>|-|--last|-n <index>|list|-h]`"
        ].join("\n")
      };
    }

    if (indexArg !== undefined || wantsLast) {
      const binding = await this.store.get(key);
      const currentProject = await this.effectiveProject(binding);
      const projectDir = projectArg || (allProjects ? undefined : currentProject);
      const sessions = await this.claude.listSessions(projectDir, 20);
      if (sessions.length === 0) {
        return this.renderCommandError("Resume", "no sessions found in current scope", "`/resume list [--all]`");
      }
      const currentSessionIdForSort = binding?.claudeSessionId;
      sessions.sort((a, b) => {
        const aCur = a.sessionId === currentSessionIdForSort ? 0 : 1;
        const bCur = b.sessionId === currentSessionIdForSort ? 0 : 1;
        if (aCur !== bCur) return aCur - bCur;
        const aProj = a.cwd || "";
        const bProj = b.cwd || "";
        if (aProj !== bProj) return aProj.localeCompare(bProj);
        const aTime = a.lastModified ? new Date(a.lastModified).getTime() : 0;
        const bTime = b.lastModified ? new Date(b.lastModified).getTime() : 0;
        return bTime - aTime;
      });
      if (wantsLast) {
        sessionId = sessions[0]?.sessionId;
      } else {
        const index = Number(indexArg);
        if (!indexArg || !Number.isInteger(index) || index < 1) {
          return this.renderCommandError("Resume", "invalid index — must be a positive integer", "`/resume -n <index>`");
        }
        const selected = sessions[index - 1];
        if (!selected) {
          return this.renderCommandError("Resume", `index ${index} out of range (1–${sessions.length})`, "`/resume list`");
        }
        sessionId = selected.sessionId;
      }
    } else {
      sessionId = cursor.remainingText() || undefined;
    }

    // If no session specified but -C was given, resolve to the latest session for that project
    if (!sessionId && cdArg) {
      const resolvedCdProject = this.resolveProject(cdArg);
      if (!this.isAllowedProject(resolvedCdProject)) {
        return this.renderCommandError("Resume", `path not in allowed roots: \`${resolvedCdProject}\``, "`/resume -C <dir>`");
      }
      const sessions = await this.claude.listSessions(resolvedCdProject, 1);
      if (sessions.length === 0) {
        return this.renderCommandError("Resume", `no sessions found for project \`${resolvedCdProject}\``, "`/resume list --all`");
      }
      sessionId = sessions[0].sessionId;
    }

    if (!sessionId) {
      return this.renderCommandError("Resume", "no session specified", "`/resume [<session-id>|-|--last|-n <index>|list]`");
    }

    const binding = await this.store.get(key);
    const now = new Date().toISOString();

    // Validate session exists, then resolve project
    const sessionInfo = await this.claude.getSessionInfo(sessionId).catch(() => undefined);
    if (!sessionInfo) {
      return this.renderCommandError("Resume", `session not found: \`${sessionId}\``, "`/resume list`");
    }
    const sessionCwd = sessionInfo?.cwd;
    let resolvedProject: string;
    if (cdArg) {
      resolvedProject = this.resolveProject(cdArg);
    } else if (sessionCwd && this.isAllowedProject(sessionCwd)) {
      resolvedProject = sessionCwd;
    } else {
      resolvedProject = await this.effectiveProject(binding);
    }

    if (binding) {
      binding.claudeSessionId = sessionId;
      binding.project = resolvedProject;
      binding.updatedAt = now;
      await this.store.put(binding);
    } else {
      await this.store.put({ conversationKey: key, claudeSessionId: sessionId, project: resolvedProject, createdAt: now, updatedAt: now });
    }

    const lastMessage = await this.claude.getLastUserMessage(sessionId).catch(() => undefined);
    const leadingLines: string[] = [];
    if (sessionCwd && sessionCwd !== resolvedProject) {
      leadingLines.push(`- **Warning**: session cwd \`${sessionCwd}\` outside allowed roots — kept existing project`);
    }
    const detail = this.renderSessionDetailText({
      sessionId,
      project: resolvedProject,
      updatedAt: now,
      sessionInfo,
      lastMessage: lastMessage || undefined,
      flags: ["bound"],
      leadingLines
    });
    if (replayMessages > 0 && onStatus) {
      const recentMessages = await this.renderRecentSessionReplayMessages(sessionId, replayMessages);
      for (const recentMessage of recentMessages) {
        await onStatus(recentMessage);
      }
    }
    return detail;
  }

  private async handlePwd(message: IncomingMessage): Promise<string> {
    const binding = await this.store.get(conversationKeyFor(message));
    return `\`${await this.effectiveProject(binding)}\``;
  }

  private async handleShellCommand(
    message: IncomingMessage,
    command: string,
    args: string[],
    onStatus?: (text: string | AppResponse) => Promise<void>
  ): Promise<string | AppResponse> {
    const binding = await this.store.get(conversationKeyFor(message));
    const project = await this.effectiveProject(binding);
    if (!this.isAllowedProject(project)) {
      return { text: `Project path not allowed: ${project}`, severity: "warning" };
    }
    await onStatus?.(this.renderLocalCommandPreamble(command, args, message.text));
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: project,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });
      const combined = this.combineCommandOutput(stdout, stderr);
      return {
        text: this.renderWrappedCommandOutput(combined),
        bodyFormat: "raw-text"
      };
    } catch (err) {
      const error = err as Error & { code?: number | string; stdout?: string; stderr?: string };
      const output = this.combineCommandOutput(error.stdout, error.stderr);
      const formatted = this.renderWrappedCommandOutput(
        output || error.message || `${command} command failed`,
        error.code
      );
      return {
        severity: error.code === undefined || error.code === 0 || error.code === "0" ? undefined : "error",
        text: formatted,
        bodyFormat: "raw-text"
      };
    }
  }

  private handleFeishu(cursor: ArgCursor): string | AppResponse {
    const sub = cursor.shift();
    if (sub === "ws" || sub === "doctor") {
      if (!this.feishu) return "Feishu gateway not initialized.";
      const diag = this.feishu.diagnostics();
      return this.renderFencedBlock("json", JSON.stringify(diag, null, 2));
    }
    return [
      "**Feishu subcommands**:",
      "- `/feishu ws` — websocket diagnostics",
      "- `/feishu doctor` — full diagnostics"
    ].join("\n");
  }

  private async handleLog(cursor: ArgCursor): Promise<string | AppResponse> {
    const nOpt = cursor.takeOption("-n");
    const limit = nOpt ? parseInt(nOpt, 10) || 30 : 30;
    try {
      const { stdout } = await execFileAsync(
        "journalctl",
        ["--user", "-u", "claude-feishu-bridge", "-n", String(limit), "--no-pager"],
        { timeout: 10_000, maxBuffer: 256 * 1024 }
      );
      return this.renderFencedBlock("text", this.truncateOutput(stdout.trim() || "(no logs)"));
    } catch (error) {
      const maybe = error as Error & { stdout?: string; stderr?: string; code?: number | string };
      const output = [maybe.stdout, maybe.stderr].filter(Boolean).join(maybe.stdout && maybe.stderr ? "\n" : "");
      return {
        severity: "error",
        text: [
          "# Log",
          "",
          `- **Unit**: \`claude-feishu-bridge.service\``,
          `- **Status**: \`failed\``,
          `- **Code**: \`${String(maybe.code ?? "(unknown)")}\``,
          "",
          this.renderFencedBlock("text", this.truncateOutput(output || maybe.message || "journalctl failed"))
        ].join("\n")
      };
    }
  }

  private renderLocalCommandPreamble(
    command: string,
    args: string[],
    rawInput: string
  ): string {
    const normalizedInput = rawInput
      .replace(/\r\n/g, "\n")
      .trimStart()
      .replace(/^\//, "");
    return [
      `Running \`${command}\`...`,
      "",
      this.renderFencedBlock("text", normalizedInput)
    ].join("\n");
  }

  private combineCommandOutput(stdout?: string, stderr?: string): string {
    return [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
  }

  private renderWrappedCommandOutput(value: string, code?: number | string): string {
    const body = this.truncateOutput(value || "(no output)");
    if (code === undefined || code === 0 || code === "0") {
      return body;
    }
    return this.truncateOutput(`Code: ${String(code)}\n\n${value || "(no output)"}`);
  }

  private renderFencedBlock(language: string, value: string): string {
    const longestBacktickRun = Math.max(
      0,
      ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)
    );
    const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
    return `${fence}${language}\n${value}\n${fence}`;
  }

  private renderSessionDetailText(options: {
    sessionId: string;
    project: string;
    updatedAt?: string;
    sessionInfo?: { createdAt?: number; fileSize?: number; cwd?: string; customTitle?: string; tag?: string; gitBranch?: string; summary?: string; firstPrompt?: string } | undefined;
    lastMessage?: string;
    flags?: string[];
    leadingLines?: string[];
  }): string {
    const { sessionId, project, updatedAt, sessionInfo, lastMessage, flags = [], leadingLines = [] } = options;
    const formatSize = (bytes?: number) => {
      if (bytes == null) return undefined;
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };
    const flagsStr = flags.filter(Boolean).join(", ");
    return [
      ...leadingLines,
      ...(leadingLines.length > 0 ? [""] : []),
      `- **Session**: \`${sessionId}\``,
      `- **Project**: \`${project}\``,
      ...(sessionInfo?.createdAt ? [`- **Created**: ${new Date(sessionInfo.createdAt).toISOString().slice(0, 19).replace("T", " ")}`] : []),
      ...(updatedAt ? [`- **Updated**: ${updatedAt}`] : []),
      ...(sessionInfo?.cwd ? [`- **Cwd**: \`${sessionInfo.cwd}\``] : []),
      ...(sessionInfo?.fileSize != null ? [`- **File size**: ${formatSize(sessionInfo.fileSize)}`] : []),
      ...(sessionInfo?.customTitle ? [`- **Name**: ${sessionInfo.customTitle}`] : []),
      ...(sessionInfo?.tag ? [`- **Tag**: \`${sessionInfo.tag}\``] : []),
      ...(sessionInfo?.gitBranch ? [`- **Branch**: \`${sessionInfo.gitBranch}\``] : []),
      ...(sessionInfo?.summary ? [`- **Summary**: ${sessionInfo.summary}`] : []),
      ...(!sessionInfo?.summary && sessionInfo?.firstPrompt ? [`- **First prompt**: ${sessionInfo.firstPrompt}`] : []),
      ...(flagsStr ? [`- **Flags**: ${flagsStr}`] : []),
      ...(lastMessage ? [`- **Last message**:`, "", this.renderFencedBlock("text", lastMessage)] : [])
    ].join("\n");
  }

  private async renderRecentSessionReplayMessages(
    sessionId: string,
    limit: number
  ): Promise<AppResponse[]> {
    const messages = await this.claude.getRecentSessionMessages(sessionId, limit).catch(() => []);
    return messages.map((message) => this.renderRecentSessionReplayMessage(message));
  }

  private renderRecentSessionReplayMessage(
    message: { role: "user" | "assistant"; text: string; timestamp?: string }
  ): AppResponse {
    const role = message.role === "assistant" ? "[Claude]" : "[User]";
    const prefix = message.timestamp ? `${role} ${this.formatLocalIsoTimestamp(message.timestamp)}` : role;
    return {
      text: `${prefix}\n\n${message.text}`,
      bodyFormat: "raw-text"
    };
  }

  private formatLocalIsoTimestamp(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return typeof value === "string" ? value : date.toISOString();
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const millis = String(date.getMilliseconds()).padStart(3, "0");
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absoluteOffsetMinutes = Math.abs(offsetMinutes);
    const offsetHours = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(2, "0");
    const offsetRemainderMinutes = String(absoluteOffsetMinutes % 60).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${sign}${offsetHours}:${offsetRemainderMinutes}`;
  }

  private truncateOutput(value: string): string {
    const limit = this.config.claude.outputSoftLimit;
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}\n\n[output truncated]`;
  }

  // ---- Claude turn execution ----

  private async handleClaudeTurn(
    message: IncomingMessage,
    onUpdate?: (update: string) => Promise<void>,
    onStatus?: (text: string | AppResponse) => Promise<void>
  ): Promise<string | AppResponse> {
    const key = conversationKeyFor(message);

    // Check for active run
    const existingRun = this.activeRuns.get(key);
    if (existingRun) {
      return { text: "A run is already active. Use `/stop` to cancel it first.", severity: "warning" };
    }

    let binding = await this.store.get(key);
    const project = binding?.project || await this.resolveDefaultProject();
    const sessionId = binding?.claudeSessionId;

    if (!this.isAllowedProject(project)) {
      return { text: `Project path not allowed: ${project}`, severity: "error" };
    }

    const { model: resolvedModel, effort: resolvedEffort } = await this.resolveModelOptions(key);
    const turnOptions: ClaudeTurnOptions = {
      model: resolvedModel,
      permissionMode: binding?.permissionMode || undefined,
      effort: resolvedEffort,
    };

    try {
      const handle = await this.claude.runTurn(
        message,
        sessionId,
        project,
        turnOptions,
        {
          onStatus: (status) => onStatus?.(status),
          onUpdate: (update) => onUpdate?.(update)
        }
      );

      this.activeRuns.set(key, {
        conversationKey: key,
        claudeSessionId: sessionId,
        runId: handle.runId,
        startedAt: new Date().toISOString(),
        status: "running"
      });

      const result = await handle.done;

      // Update binding with session ID and cwd from the turn
      if (result.sessionId || result.cwd) {
        const now = new Date().toISOString();
        const resolvedProject = result.cwd && this.isAllowedProject(result.cwd)
          ? result.cwd
          : project;
        if (binding) {
          if (result.sessionId) binding.claudeSessionId = result.sessionId;
          binding.project = resolvedProject;
          binding.updatedAt = now;
          await this.store.put(binding);
        } else {
          binding = {
            conversationKey: key,
            claudeSessionId: result.sessionId,
            project: resolvedProject,
            createdAt: now,
            updatedAt: now
          };
          await this.store.put(binding);
        }
      }

      return result.output || "(no output)";
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { text: `Claude error: ${errMsg}`, severity: "error" };
    } finally {
      this.activeRuns.delete(key);
    }
  }

  private async listProjects(currentProject?: string, knownPaths?: Iterable<string>): Promise<string[]> {
    const all = new Set<string>(knownPaths);
    const bindings = await this.store.list();
    for (const b of bindings) {
      if (b.project && !this.isStaleProject(b.project)) all.add(b.project);
    }
    return [...all].sort((a, b) => {
      if (a === currentProject) return -1;
      if (b === currentProject) return 1;
      const byName = path.basename(a).localeCompare(path.basename(b));
      if (byName !== 0) return byName;
      return a.localeCompare(b);
    });
  }

  // ---- Helpers ----

  private titleForCommand(commandName: string | undefined, text: string): string {
    const maxLen = this.config.feishu.titleMaxLength;
    if (!commandName) {
      const preview = text.replace(/\s+/g, " ").trim() || "Claude";
      const prefix = "Claude | \ud83e\udd16 ";
      if (prefix.length >= maxLen) return "Claude";
      return `${prefix}${preview.slice(0, maxLen - prefix.length)}`;
    }
    // Shell passthrough commands: show "cmd args..." truncated to maxLen
    if (SHELL_COMMAND_NAMES.has(commandName)) {
      const full = text.replace(/\s+/g, " ").trim();
      return full.length > maxLen ? full.slice(0, maxLen - 3) + "..." : full;
    }
    // Bridge commands: "Base | emoji /command args"
    const base = COMMAND_BASE_TITLES[commandName] || commandName;
    const emoji = this.commandTitleEmoji(commandName);
    const prefix = `${base} | ${emoji ? `${emoji} ` : ""}`;
    if (prefix.length >= maxLen) return base.slice(0, maxLen);
    return `${prefix}${text.slice(0, maxLen - prefix.length)}`;
  }

  private commandTitleEmoji(commandName: string): string | undefined {
    switch (commandName) {
      case "help": return "\u2753";
      case "status": return "\ud83d\udcca";
      case "new": return "\u2728";
      case "session": return "\ud83e\udded";
      case "resume": return "\u25b6\ufe0f";
      case "stop": return "\ud83d\uded1";
      case "model": return "\ud83e\udde0";
      case "permission": return "\ud83d\udd10";
      case "project": return "\ud83d\udcc2";
      case "feishu": return "\ud83d\udcac";
      case "log": return "\ud83d\udccb";
      default: return undefined;
    }
  }

  private templateForCommand(commandName: string | undefined): OutgoingMessage["template"] {
    if (!commandName) return "indigo";
    if (commandName === "status" || commandName === "help") return "turquoise";
    if (commandName === "new" || commandName === "resume") return "green";
    if (commandName === "stop") return "orange";
    return "wathet";
  }

  private async readClaudeSettings(): Promise<{ model?: string; effortLevel?: string }> {
    if (this.claudeSettingsCache !== undefined) return this.claudeSettingsCache ?? {};
    try {
      const home = process.env["HOME"] || "";
      const settingsPath = path.join(home, ".claude", "settings.json");
      const raw = await readFile(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      this.claudeSettingsCache = {
        model: typeof parsed["model"] === "string" ? parsed["model"] : undefined,
        effortLevel: typeof parsed["effortLevel"] === "string" ? parsed["effortLevel"] : undefined,
      };
    } catch {
      this.claudeSettingsCache = null;
    }
    return this.claudeSettingsCache ?? {};
  }

  // Resolve effective model and effort for a conversation.
  // Priority: in-memory Feishu override → ~/.claude/settings.json → bridge config default
  private async resolveModelOptions(key: string): Promise<{ model?: string; effort?: string }> {
    const override = this.modelOverrides.get(key);
    const cs = await this.readClaudeSettings();
    return {
      model: override?.model || cs.model || this.config.claude.defaultModel || undefined,
      effort: override?.effort || cs.effortLevel || this.config.claude.defaultEffortLevel || undefined,
    };
  }

  private async buildFooter(key: string, binding: SessionBinding | undefined): Promise<string> {
    const ts = formatIsoTimestamp(new Date());
    const { model, effort } = await this.resolveModelOptions(key);
    const project = await this.effectiveProject(binding);
    const sessionId = binding?.claudeSessionId;

    const modelPart = [model, effort].filter(Boolean).join(" ");
    const parts = ([modelPart || undefined, `\`${project}\``, sessionId] as (string | undefined)[]).filter(Boolean) as string[];
    return parts.length ? `${ts}  |  ${parts.join(" · ")}` : ts;
  }

  private withBodyFormat(
    result: string | AppResponse,
    bodyFormat?: OutgoingBodyFormat
  ): string | AppResponse {
    if (!bodyFormat) return result;
    if (typeof result === "string") {
      return { text: result, bodyFormat };
    }
    return { ...result, bodyFormat };
  }

  private resolveProject(dirArg: string): string {
    return path.resolve(dirArg);
  }

  // Returns true for bindings that were set to the user home by the old default —
  // treat them as "no explicit project" so resolveDefaultProject() can do better.
  private isStaleProject(project: string): boolean {
    const home = process.env["HOME"] || process.env["USERPROFILE"] || "";
    return home !== "" && project === home;
  }

  private async resolveDefaultProject(): Promise<string> {
    // Prefer the cwd of the most recently active Claude session over the configured default
    try {
      const sessions = await this.claude.listSessions(undefined, 1);
      const cwd = sessions[0]?.cwd;
      if (cwd && this.isAllowedProject(cwd)) return cwd;
    } catch {
      // fall through
    }
    return this.config.project.defaultProject;
  }

  // Resolve the effective project for a binding, treating stale home-dir entries
  // as unset so resolveDefaultProject() can provide a better answer.
  private async effectiveProject(binding: SessionBinding | undefined): Promise<string> {
    if (binding?.project && !this.isStaleProject(binding.project)) {
      return binding.project;
    }
    return this.resolveDefaultProject();
  }

  private isAllowedProject(project: string): boolean {
    return this.config.project.allowedRoots.some((root) => {
      const relative = path.relative(root, project);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
  }

  private previewText(value: string, maxLength = 120): string {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
  }

  private async sendStartupReadyNotification(label: string, logMessage: string): Promise<void> {
    const startupChatId = this.config.feishu.startupNotifyChatId;
    const startupKey = startupChatId ? `p2p:${startupChatId}` : undefined;
    const [version, binding] = await Promise.all([
      this.claude.getVersion(),
      startupKey ? this.store.get(startupKey) : Promise.resolve(undefined)
    ]);
    const project = await this.effectiveProject(binding);
    const footer = await this.buildFooter(startupKey || "", binding);
    const permissionMode = binding?.permissionMode || this.config.claude.permissionMode;
    const text = [
      `Claude Code: ${version || "unknown"}`,
      `Permission: ${permissionMode}`,
    ].join("\n");
    try {
      await this.feishu?.sendStartupReady(text, footer, label);
      console.log(logMessage);
    } catch (error) {
      console.warn("failed to send startup notification", error);
    }
  }
}

function formatIsoTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(abs / 60)).padStart(2, "0");
  const offsetSecs = String(abs % 60).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${sign}${offsetHours}:${offsetSecs}`;
}
