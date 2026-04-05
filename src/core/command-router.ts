import { IncomingMessage } from "../types/domain.js";

export type CommandName =
  | "help"
  | "status"
  | "new"
  | "session"
  | "resume"
  | "rename"
  | "stop"
  | "model"
  | "permission"
  | "project"
  | "git"
  | "cat"
  | "cp"
  | "find"
  | "head"
  | "ls"
  | "ln"
  | "mkdir"
  | "mv"
  | "pwd"
  | "readlink"
  | "rg"
  | "rmdir"
  | "sha256sum"
  | "tail"
  | "tar"
  | "touch"
  | "trash"
  | "tree"
  | "wc"
  | "feishu"
  | "log";

export interface ParsedCommand {
  name: string;
  args: string[];
}

export interface ParsedCommandError {
  name?: string;
  parseError: string;
}

function tokenizeCommandText(text: string): { tokens: string[]; parseError?: string } {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      if (
        quote === '"' &&
        char === "\\" &&
        next &&
        (next === quote || next === "\\" || next === "$" || next === "`" || next === "\n")
      ) {
        if (next !== "\n") {
          current += next;
        }
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (
      char === "\\" &&
      next &&
      (/\s/.test(next) || next === "'" || next === '"' || next === "\\")
    ) {
      current += next;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  if (quote) {
    return {
      tokens,
      parseError: `unterminated ${quote === '"' ? "double" : "single"} quote`
    };
  }
  return { tokens };
}

export const BUILTIN_COMMAND_NAMES: readonly string[] = [
  "help",
  "status",
  "new",
  "session",
  "resume",
  "rename",
  "stop",
  "model",
  "permission",
  "project",
  "git",
  "cat",
  "cp",
  "find",
  "head",
  "ls",
  "ln",
  "mkdir",
  "mv",
  "pwd",
  "readlink",
  "rg",
  "rmdir",
  "sha256sum",
  "tail",
  "tar",
  "touch",
  "trash",
  "tree",
  "wc",
  "feishu",
  "log"
];

export function parseCommand(message: IncomingMessage, extraNames: readonly string[] = []): ParsedCommand | ParsedCommandError | undefined {
  const text = message.text.trim();
  if (!text.startsWith("/")) return undefined;
  const { tokens, parseError } = tokenizeCommandText(text.slice(1));
  const [head, ...args] = tokens;
  if ([...BUILTIN_COMMAND_NAMES, ...extraNames].includes(head)) {
    if (parseError) {
      return { name: head, parseError };
    }
    return { name: head, args };
  }
  return undefined;
}
