export interface ParsedShellCommands {
  readonly commands: readonly (readonly string[])[];
  readonly reliable: boolean;
}

const SHELL_CONTROL_WORDS = new Set([
  "case",
  "cd",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "select",
  "then",
  "until",
  "while",
]);

function hasDynamicShellSyntax(value: string): boolean {
  return /`|\$[({A-Za-z_]|[<>]\(|\*\*|\?\(/u.test(value);
}

/**
 * Split the conservative shell subset used by package scripts. Unsupported
 * dynamic/control-flow syntax is still tokenized where possible, but marks the
 * result unreliable so strict integrity enforcement can fail closed.
 */
export function parseShellCommands(value: string): ParsedShellCommands {
  const commands: string[][] = [];
  let currentCommand: string[] = [];
  let currentToken = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let reliable = !hasDynamicShellSyntax(value);

  const finishToken = (): void => {
    if (!tokenStarted) return;
    currentCommand.push(currentToken);
    currentToken = "";
    tokenStarted = false;
  };
  const finishCommand = (): void => {
    finishToken();
    if (currentCommand.length > 0) commands.push(currentCommand);
    currentCommand = [];
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) continue;
    if (escaped) {
      currentToken += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else currentToken += character;
      tokenStarted = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        escaped = true;
      } else {
        currentToken += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (character === "\n" || character === "\r") finishCommand();
      else finishToken();
      continue;
    }
    if (character === ";" || character === "|") {
      finishCommand();
      if (value[index + 1] === character) index += 1;
      continue;
    }
    if (character === "&" && value[index + 1] === "&") {
      finishCommand();
      index += 1;
      continue;
    }
    if (character === "&") {
      finishCommand();
      reliable = false;
      continue;
    }
    if (character === "(" || character === ")" || character === "{" || character === "}") {
      reliable = false;
    }
    currentToken += character;
    tokenStarted = true;
  }
  if (escaped || quote !== undefined) reliable = false;
  finishCommand();
  if (commands.some((argv) => SHELL_CONTROL_WORDS.has(argv[0]?.toLowerCase() ?? ""))) {
    reliable = false;
  }
  return { commands, reliable };
}
