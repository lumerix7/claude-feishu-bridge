import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeBackend, ClaudeTurnOptions } from "../adapters/claude/backend.js";
import { createClaudeBackend } from "../adapters/claude/claude-runtime.js";
import { FeishuGateway } from "../adapters/feishu/feishu-gateway.js";
import { AppConfig } from "../config/env.js";
import { conversationKeyFor } from "./conversation-key.js";
import { parseCommand } from "./command-router.js";
import { BindingStore } from "../store/binding-store.js";
import { ActiveRun, IncomingMessage, OutgoingMessage, SessionBinding } from "../types/domain.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 30_000;

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
        const includeRawMarkdown = this.shouldIncludeRawMarkdownForMessage(commandName);
        try {
          let streamed = false;
          let lastUpdateText: string | undefined;
          let accumulatedStreamText = "";
          let statusChain = Promise.resolve();
          let streamingSendInFlight = false;
          let queuedStreamingSnapshot: string | undefined;
          let streamDrain = Promise.resolve();
          const streamKey = `${message.chatId}:${message.threadId || "root"}:${message.messageId}:${commandName || "claude"}`;

          const sendStatusSafely = async (update: string): Promise<void> => {
            statusChain = statusChain.then(async () => {
              try {
                const latestBinding = (await this.store.get(conversationKeyFor(message))) || currentBinding;
                await this.feishu?.send({
                  chatId: message.chatId,
                  title: messageTitle,
                  template: messageTemplate,
                  footer: await this.footerForMessage(commandName, msgKey, latestBinding),
                  text: update,
                  replyToMessageId: message.messageId,
                  threadId: message.threadId,
                  streaming: false,
                  includeRawMarkdown
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
                footer: await this.footerForClaudeReply(msgKey, latestBinding),
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
          await statusChain;
          await streamDrain;

          const formattedText = commandName
            ? text
            : accumulatedStreamText || text;
          const shouldFinalizeLiveStream = !commandName && streamed;

          if ((formattedText && formattedText !== lastUpdateText) || !streamed || shouldFinalizeLiveStream) {
            const latestBinding = (await this.store.get(conversationKeyFor(message))) || currentBinding;
            const finalFooter = commandName
              ? await this.footerForMessage(commandName, msgKey, latestBinding)
              : await this.footerForClaudeReply(msgKey, latestBinding);
            const finalTemplate = responseSeverity === "error" ? "red"
              : responseSeverity === "warning" ? "yellow"
              : messageTemplate;
            await this.feishu?.send({
              chatId: message.chatId,
              title: messageTitle,
              template: finalTemplate,
              footer: finalFooter,
              text: formattedText,
              includeRawMarkdown,
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
    onStatus?: (text: string) => Promise<void>
  ): Promise<string | AppResponse> {
    if (message.chatType !== "p2p") {
      return "Only direct messages are supported right now.";
    }

    const parsedCommand = parseCommand(message);
    if (parsedCommand && "parseError" in parsedCommand) {
      return { text: `Parse error: ${parsedCommand.parseError}`, severity: "warning" };
    }
    const command = parsedCommand;

    if (command?.name === "help") return this.handleHelp();
    if (command?.name === "status") return this.handleStatus(message, new ArgCursor(command.args));
    if (command?.name === "new") return this.handleNew(message, new ArgCursor(command.args));
    if (command?.name === "stop") return this.handleStop(message);
    if (command?.name === "model") return this.handleModel(message, new ArgCursor(command.args));
    if (command?.name === "permission") return this.handlePermission(message, new ArgCursor(command.args));
    if (command?.name === "project") return this.handleProject(message, new ArgCursor(command.args));
    if (command?.name === "session") return this.handleSession(message, new ArgCursor(command.args));
    if (command?.name === "resume") return this.handleResume(message, new ArgCursor(command.args));

    // File system commands
    if (command?.name === "git") return this.handleShellCommand(message, "git", command.args);
    if (command?.name === "pwd") return this.handlePwd(message);
    if (command?.name === "ls") return this.handleShellCommand(message, "ls", command.args);
    if (command?.name === "cat") return this.handleShellCommand(message, "cat", command.args);
    if (command?.name === "head") return this.handleShellCommand(message, "head", command.args);
    if (command?.name === "tail") return this.handleShellCommand(message, "tail", command.args);
    if (command?.name === "find") return this.handleShellCommand(message, "find", command.args);
    if (command?.name === "rg") return this.handleShellCommand(message, "rg", command.args);
    if (command?.name === "tree") return this.handleShellCommand(message, "tree", command.args);
    if (command?.name === "wc") return this.handleShellCommand(message, "wc", command.args);
    if (command?.name === "cp") return this.handleShellCommand(message, "cp", command.args);
    if (command?.name === "mv") return this.handleShellCommand(message, "mv", command.args);
    if (command?.name === "mkdir") return this.handleShellCommand(message, "mkdir", command.args);
    if (command?.name === "touch") return this.handleShellCommand(message, "touch", command.args);
    if (command?.name === "ln") return this.handleShellCommand(message, "ln", command.args);
    if (command?.name === "rmdir") return this.handleShellCommand(message, "rmdir", command.args);
    if (command?.name === "readlink") return this.handleShellCommand(message, "readlink", command.args);
    if (command?.name === "sha256sum") return this.handleShellCommand(message, "sha256sum", command.args);
    if (command?.name === "tar") return this.handleShellCommand(message, "tar", command.args);
    if (command?.name === "trash") return this.handleShellCommand(message, "trash", command.args);

    if (command?.name === "feishu") return this.handleFeishu(new ArgCursor(command.args));
    if (command?.name === "log") return this.handleLog(new ArgCursor(command.args));

    // Not a command — send to Claude
    return this.handleClaudeTurn(message, onUpdate, onStatus);
  }

  // ---- Helpers ----

  private renderCommandError(title: string, error: string, usage?: string): AppResponse {
    return {
      severity: "warning",
      text: [
        `# ${title}`,
        "",
        `- **Error**: ${error}`,
        ...(usage ? [`- **Usage**: ${usage}`] : [])
      ].join("\n")
    };
  }

  // ---- Command handlers ----

  private handleHelp(): string {
    return [
      "## Core",
      "",
      "- `/help` show commands",
      "- `/status` show current session and bridge state",
      "- `/new [-C|--cd <dir>] [-h|--help]` create and bind a fresh Claude session",
      "- `/session [list [-n <count>] [--all] [--project <path>]] [-h|--help]` inspect current session or browse recent sessions",
      "- `/resume [<session-id>|--last|-n <index>|--list] [-C <dir>] [-h|--help]` bind a previous session",
      "- `/stop` stop the current active run",
      "",
      "## Claude",
      "",
      "- `/model [<name>|list] [-e|--effort <level>] [-h|--help]` show or set the model and effort level",
      "- `/permission [<mode>]` show or set the permission mode",
      "  - modes: `bypassPermissions` `acceptEdits` `auto` `default` `plan`",
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
      "- `/log [-n <count>]` show recent bridge service logs from systemd journal"
    ].join("\n");
  }

  private shouldIncludeRawMarkdownForMessage(commandName?: string): boolean {
    return commandName === "help";
  }

  private async handleStatus(message: IncomingMessage, cursor: ArgCursor): Promise<string> {
    const key = conversationKeyFor(message);
    const binding = await this.store.get(key);
    const activeRun = this.activeRuns.get(key);

    const version = await this.claude.getVersion();
    const project = await this.effectiveProject(binding);

    const lines: string[] = [
      `**Claude Code**: ${version || "unknown"}`,
      `**Model**: ${binding?.model || this.config.claude.defaultModel || "(default)"}`,
      `**Effort**: ${binding?.effort || "high (default)"}`,
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
      const currentModel = binding?.model || this.config.claude.defaultModel || "";
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

    // No args → show current
    if (!modelName && !effort) {
      const currentModel = binding?.model || this.config.claude.defaultModel || "(default)";
      const currentEffort = binding?.effort || "high (default)";
      return `**Model**: ${currentModel}\n**Effort**: ${currentEffort}`;
    }

    // Apply changes
    const now = new Date().toISOString();
    const lines: string[] = [];
    if (binding) {
      if (modelName) binding.model = modelName;
      if (effort) binding.effort = effort;
      binding.updatedAt = now;
      await this.store.put(binding);
    } else {
      await this.store.put({
        conversationKey: key,
        project: this.config.project.defaultProject,
        ...(modelName ? { model: modelName } : {}),
        ...(effort ? { effort } : {}),
        createdAt: now,
        updatedAt: now
      });
    }
    if (modelName) lines.push(`Model set to: **${modelName}**`);
    if (effort) lines.push(`Effort set to: **${effort}**`);
    return lines.join("\n");
  }

  private async handlePermission(message: IncomingMessage, cursor: ArgCursor): Promise<string> {
    const key = conversationKeyFor(message);
    const binding = await this.store.get(key);
    const mode = cursor.remainingText();

    if (!mode) {
      return `**Current permission mode**: ${binding?.permissionMode || this.config.claude.permissionMode}`;
    }

    const validModes = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];
    if (!validModes.includes(mode)) {
      return `Invalid permission mode. Valid: ${validModes.join(", ")}`;
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
      "- `/project bind /volumes/ws/my-project`",
      "- `/project bind -n 2`",
      "- `/project bind --mkdir /volumes/ws/new-project`",
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
      "Inspect the current bound session or browse recent Claude Code sessions.",
      "",
      "## Usage",
      "",
      "- `/session` — show the current bound session",
      "- `/session list [-n <count>] [--all] [--project <path>]` — list recent sessions",
      "- `/session -h|--help` — show this help",
      "",
      "## List options",
      "",
      "- `-n <count>` limit the number of sessions shown (default: 20)",
      "- `--all` include sessions from all projects (default: current project only)",
      "- `--project <path>` filter to a specific project path",
      "",
      "## Columns",
      "",
      "- **Project** — working directory of the session",
      "- **Updated** — last modified time",
      "- **Session** — full session UUID (copy to use with `/resume`)",
      "- **Last message** — last user message sent in the session",
      "- **Summary** — Claude-generated session summary or first prompt",
      "- **Branch** — git branch at end of session",
      "- **Flags** — `current` (bound to this chat), `bound` (bound elsewhere), tag, custom title",
      "",
      "## Examples",
      "",
      "- `/session`",
      "- `/session list`",
      "- `/session list -n 5`",
      "- `/session list --all`",
      "- `/resume <session-id>`"
    ].join("\n");
  }

  private async handleSession(message: IncomingMessage, cursor: ArgCursor): Promise<string | AppResponse> {
    const key = conversationKeyFor(message);
    const sub = cursor.shift();
    if (sub === "-h" || sub === "--help") return this.sessionHelpText();
    if (sub === "list") {
      if (cursor.peek() === "-h" || cursor.peek() === "--help") return this.sessionHelpText();
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

      // Fetch last user message for each session in parallel
      const lastMessages = await Promise.all(
        sessions.map((s) => this.claude.getLastUserMessage(s.sessionId).catch(() => undefined))
      );

      const escapeCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const header = "| # | Project | Updated | Session | Last message | Summary | Branch | Flags |";
      const divider = "| --- | --- | --- | --- | --- | --- | --- | --- |";
      const rows = sessions.map((s, i) => {
        const project = s.cwd ? `\`${s.cwd}\`` : "-";
        const updated = s.lastModified
          ? new Date(s.lastModified).toISOString().slice(0, 19).replace("T", " ")
          : "-";
        const sessionId = `\`${s.sessionId}\``;
        const lastMsg = lastMessages[i] ? escapeCell(lastMessages[i]!) : "-";
        const summary = escapeCell(s.summary || s.firstPrompt || "(no preview)");
        const branch = s.gitBranch ? `\`${s.gitBranch}\`` : "-";
        const flags = [
          s.sessionId === currentSessionId ? "**current**" : "",
          boundIds.has(s.sessionId) && s.sessionId !== currentSessionId ? "bound" : "",
          s.tag ? `\`${s.tag}\`` : "",
          s.customTitle ? `_${s.customTitle}_` : ""
        ].filter(Boolean).join(" ");
        return `| ${i + 1} | ${project} | ${updated} | ${sessionId} | ${lastMsg} | ${summary} | ${branch} | ${flags || "-"} |`;
      });

      return [header, divider, ...rows].join("\n");
    }
    const binding = await this.store.get(key);
    if (!binding?.claudeSessionId) {
      return "No active session. Send a message or use `/new` to start.";
    }
    const sessionInfo = await this.claude.getSessionInfo(binding.claudeSessionId).catch(() => undefined);
    return [
      `**Session**: \`${binding.claudeSessionId}\``,
      `**Project**: \`${binding.project}\``,
      `**Updated**: ${binding.updatedAt}`,
      ...(sessionInfo?.gitBranch ? [`**Branch**: \`${sessionInfo.gitBranch}\``] : []),
      ...(sessionInfo?.summary ? [`**Summary**: ${sessionInfo.summary}`] : [])
    ].join("\n");
  }

  private resumeHelpText(): string {
    return [
      "Resume a Claude session and bind it to this conversation.",
      "",
      "## Usage",
      "",
      "- `/resume <session-id>` — bind one specific session by ID",
      "- `/resume --last` — bind the most recent session in the current scope",
      "- `/resume -n <index>` — bind the Nth session from the current `/session list` ordering",
      "- `/resume --list [--all] [--project <path>]` — show resumable sessions",
      "- `/resume -h|--help` — show this help",
      "",
      "## Options",
      "",
      "### Select Session",
      "",
      "- `<session-id>` bind one specific session ID",
      "- `--last` bind the most recent session in the current scope",
      "- `-n <index>` bind the Nth session from the current `/session list` ordering",
      "",
      "### List Scope",
      "",
      "- `--list` show the current resumable session list",
      "- `--all` expand browsing beyond the current project for `--list`",
      "- `--project <path>` scope `--list` browsing to one project path",
      "",
      "### Project",
      "",
      "- `-C, --cd <dir>` switch the conversation project when binding the session",
      "",
      "### General",
      "",
      "- `-h, --help` show resume help",
      "",
      "## Examples",
      "",
      "- `/resume 41252e25-f28c-4351-9fcf-3b22a9b3c326`",
      "- `/resume --last`",
      "- `/resume -n 2`",
      "- `/resume --list`",
      "- `/resume --list --all`"
    ].join("\n");
  }

  private async handleResume(message: IncomingMessage, cursor: ArgCursor): Promise<string | AppResponse> {
    const key = conversationKeyFor(message);

    if (cursor.peek() === "-h" || cursor.peek() === "--help") return this.resumeHelpText();

    const showList = cursor.takeFlag("--list");
    const allProjects = cursor.takeFlag("--all");
    const projectArg = cursor.takeOption("--project");
    const indexArg = cursor.takeOption("-n");
    const last = cursor.takeFlag("--last");
    const cdArg = cursor.takeOption("-C", "--cd");

    // --list: show sessions table (same as /session list but scoped)
    if (showList) {
      if (!cursor.isEmpty()) {
        return this.renderCommandError("Resume", `unsupported argument \`${cursor.peek()}\``, "`/resume --list [--all] [--project <path>]`");
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
      const lastMessages = await Promise.all(
        sessions.map((s) => this.claude.getLastUserMessage(s.sessionId).catch(() => undefined))
      );
      const escapeCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const header = "| # | Project | Updated | Session | Last message | Summary | Branch | Flags |";
      const divider = "| --- | --- | --- | --- | --- | --- | --- | --- |";
      const rows = sessions.map((s, i) => {
        const project = s.cwd ? `\`${s.cwd}\`` : "-";
        const updated = s.lastModified ? new Date(s.lastModified).toISOString().slice(0, 19).replace("T", " ") : "-";
        const sessionId = `\`${s.sessionId}\``;
        const lastMsg = lastMessages[i] ? escapeCell(lastMessages[i]!) : "-";
        const summary = escapeCell(s.summary || s.firstPrompt || "(no preview)");
        const branch = s.gitBranch ? `\`${s.gitBranch}\`` : "-";
        const flags = [
          s.sessionId === currentSessionId ? "`current`" : "",
          boundIds.has(s.sessionId) && s.sessionId !== currentSessionId ? "bound" : "",
          s.tag ? `\`${s.tag}\`` : "",
          s.customTitle ? `_${s.customTitle}_` : ""
        ].filter(Boolean).join(" ");
        return `| ${i + 1} | ${project} | ${updated} | ${sessionId} | ${lastMsg} | ${summary} | ${branch} | ${flags || "-"} |`;
      });
      return [header, divider, ...rows].join("\n");
    }

    // Resolve target session ID
    let sessionId: string | undefined;

    if (indexArg !== undefined || last) {
      const binding = await this.store.get(key);
      const currentProject = await this.effectiveProject(binding);
      const projectDir = projectArg || (allProjects ? undefined : currentProject);
      const sessions = await this.claude.listSessions(projectDir, 20);
      if (sessions.length === 0) {
        return this.renderCommandError("Resume", "no sessions found in current scope", "`/resume --list [--all]`");
      }
      if (last) {
        sessionId = sessions[0]?.sessionId;
      } else {
        const index = Number(indexArg);
        if (!indexArg || !Number.isInteger(index) || index < 1) {
          return this.renderCommandError("Resume", "invalid index — must be a positive integer", "`/resume -n <index>`");
        }
        const selected = sessions[index - 1];
        if (!selected) {
          return this.renderCommandError("Resume", `index ${index} out of range (1–${sessions.length})`, "`/resume --list`");
        }
        sessionId = selected.sessionId;
      }
    } else {
      sessionId = cursor.remainingText() || undefined;
    }

    if (!sessionId) {
      return this.renderCommandError("Resume", "no session specified", "`/resume [<session-id>|--last|-n <index>|--list] [-h|--help]`");
    }

    const binding = await this.store.get(key);
    const now = new Date().toISOString();

    // Resolve project: -C/--cd arg > session cwd > current effective project
    const sessionInfo = await this.claude.getSessionInfo(sessionId).catch(() => undefined);
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

    const lines = [`Resumed session: \`${sessionId}\``, `**Project**: \`${resolvedProject}\``];
    if (sessionCwd && sessionCwd !== resolvedProject) {
      lines.push(`_(session cwd \`${sessionCwd}\` outside allowed roots — kept existing project)_`);
    }
    return lines.join("\n");
  }

  private async handlePwd(message: IncomingMessage): Promise<string> {
    const binding = await this.store.get(conversationKeyFor(message));
    return `\`${await this.effectiveProject(binding)}\``;
  }

  private async handleShellCommand(
    message: IncomingMessage,
    command: string,
    args: string[]
  ): Promise<string | AppResponse> {
    const binding = await this.store.get(conversationKeyFor(message));
    const project = await this.effectiveProject(binding);
    if (!this.isAllowedProject(project)) {
      return { text: `Project path not allowed: ${project}`, severity: "warning" };
    }
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: project,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: 512 * 1024
      });
      const output = (stdout || stderr || "(no output)").trim();
      const truncated = output.length > 8000 ? output.slice(0, 8000) + "\n... (truncated)" : output;
      return `\`\`\`\n${truncated}\n\`\`\``;
    } catch (err) {
      const error = err as Error & { stdout?: string; stderr?: string };
      const output = (error.stderr || error.stdout || error.message).trim();
      return { text: `\`\`\`\n${output.slice(0, 4000)}\n\`\`\``, severity: "error" };
    }
  }

  private handleFeishu(cursor: ArgCursor): string | AppResponse {
    const sub = cursor.shift();
    if (sub === "ws" || sub === "doctor") {
      if (!this.feishu) return "Feishu gateway not initialized.";
      const diag = this.feishu.diagnostics();
      return `\`\`\`json\n${JSON.stringify(diag, null, 2)}\n\`\`\``;
    }
    return [
      "**Feishu subcommands**:",
      "- `/feishu ws` — websocket diagnostics",
      "- `/feishu doctor` — full diagnostics"
    ].join("\n");
  }

  private async handleLog(cursor: ArgCursor): Promise<string> {
    const nOpt = cursor.takeOption("-n");
    const limit = nOpt ? parseInt(nOpt, 10) || 30 : 30;
    try {
      const { stdout } = await execFileAsync(
        "journalctl",
        ["--user", "-u", "claude-feishu-bridge", "-n", String(limit), "--no-pager"],
        { timeout: 10_000, maxBuffer: 256 * 1024 }
      );
      return `\`\`\`\n${stdout.trim() || "(no logs)"}\n\`\`\``;
    } catch (err) {
      return `\`\`\`\n${(err as Error).message}\n\`\`\``;
    }
  }

  // ---- Claude turn execution ----

  private async handleClaudeTurn(
    message: IncomingMessage,
    onUpdate?: (update: string) => Promise<void>,
    onStatus?: (text: string) => Promise<void>
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

    const turnOptions: ClaudeTurnOptions = {
      model: binding?.model || undefined,
      permissionMode: binding?.permissionMode || undefined,
      effort: binding?.effort || undefined,
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

  private async footerForMessage(commandName: string | undefined, key: string, binding: SessionBinding | undefined): Promise<string> {
    if (!commandName) return this.footerForClaudeReply(key, binding);
    return this.buildFooter(key, binding);
  }

  private async footerForClaudeReply(key: string, binding: SessionBinding | undefined): Promise<string> {
    const ts = formatIsoTimestamp(new Date());
    const model = binding?.model || this.config.claude.defaultModel;
    const project = await this.effectiveProject(binding);
    const sessionId = binding?.claudeSessionId;
    const summary = [model, `\`${project}\``, sessionId]
      .filter(Boolean)
      .join(" · ");
    return summary ? `${ts}  |  ${summary}` : ts;
  }

  private async buildFooter(key: string, binding: SessionBinding | undefined): Promise<string> {
    const ts = formatIsoTimestamp(new Date());
    const project = await this.effectiveProject(binding);
    return `${ts}  |  \`${project}\``;
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
    const text = [
      `Claude Code: ${version || "unknown"}`,
      `Model: ${this.config.claude.defaultModel || "(default)"}`,
      `Project: \`${project}\``
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
