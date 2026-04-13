export interface ParsedArgs {
  command: string; // "generate" | "batch"
  subcommand?: string; // "submit" | "status" | "fetch" | "list" | "cancel"
  positional?: string; // file path or job ID
  flags: {
    prompt?: string;
    prompts?: string;
    model?: string;
    provider?: string;
    ar?: string;
    quality?: string;
    ref?: string[];
    outdir: string;
    json: boolean;
    async: boolean;
  };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: "",
    flags: {
      outdir: ".",
      json: false,
      async: false,
    },
  };

  let i = 0;

  // First arg is command
  if (i < argv.length && !argv[i].startsWith("-")) {
    result.command = argv[i++];
  }

  // For batch command, next non-flag is subcommand
  if (result.command === "batch" && i < argv.length && !argv[i].startsWith("-")) {
    result.subcommand = argv[i++];
  }

  // For batch subcommands, next non-flag is positional (file or jobId)
  if (
    result.command === "batch" &&
    result.subcommand &&
    result.subcommand !== "list" &&
    i < argv.length &&
    !argv[i].startsWith("-")
  ) {
    result.positional = argv[i++];
  }

  // Parse remaining flags
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--prompt":
        result.flags.prompt = argv[++i];
        break;
      case "--prompts":
        result.flags.prompts = argv[++i];
        break;
      case "--model":
      case "-m":
        result.flags.model = argv[++i];
        break;
      case "--provider":
        result.flags.provider = argv[++i];
        break;
      case "--ar":
        result.flags.ar = argv[++i];
        break;
      case "--quality":
        result.flags.quality = argv[++i];
        break;
      case "--ref":
        if (!result.flags.ref) result.flags.ref = [];
        result.flags.ref.push(argv[++i]);
        break;
      case "--outdir":
      case "-o":
        result.flags.outdir = argv[++i];
        break;
      case "--json":
        result.flags.json = true;
        break;
      case "--async":
        result.flags.async = true;
        break;
      default:
        // Unknown flag — skip
        break;
    }
    i++;
  }

  return result;
}
