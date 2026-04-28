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
    /** Resolution tier. */
    resolution?: string;
    /** Detail tier. */
    detail?: string;
    ref?: string[];
    edit?: string;
    mask?: string;
    outdir: string;
    json: boolean;
    async: boolean;
    chain: boolean;
    character?: string;
  };
}

const ALLOWED_AR = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "2:1", "1:2", "21:9", "9:21",
]);
const ALLOWED_RESOLUTION = new Set(["1k", "2k", "4k"]);
const ALLOWED_DETAIL = new Set(["auto", "low", "medium", "high"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: "",
    flags: {
      outdir: ".",
      json: false,
      async: false,
      chain: false,
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

  function nextVal(flag: string): string {
    if (i + 1 >= argv.length) throw new Error(`Flag ${flag} requires a value`);
    return argv[++i];
  }

  // Parse remaining flags
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--prompt":
        result.flags.prompt = nextVal(arg);
        break;
      case "--prompts":
        result.flags.prompts = nextVal(arg);
        break;
      case "--model":
      case "-m":
        result.flags.model = nextVal(arg);
        break;
      case "--provider":
        result.flags.provider = nextVal(arg);
        break;
      case "--ar": {
        const v = nextVal(arg);
        if (!ALLOWED_AR.has(v)) {
          throw new Error(`Invalid --ar: ${v}. Must be one of: ${[...ALLOWED_AR].join(", ")}`);
        }
        result.flags.ar = v;
        break;
      }
      case "--quality": {
        // Removed in Task 1.6. Throw with migration guidance.
        // Lazy import to avoid circular dependency at module load time.
        const { QUALITY_REMOVED_MSG } = require("./config") as { QUALITY_REMOVED_MSG: string };
        throw new Error(QUALITY_REMOVED_MSG);
      }
      case "--resolution": {
        const v = nextVal(arg);
        if (!ALLOWED_RESOLUTION.has(v)) {
          throw new Error(`Invalid --resolution: ${v}. Must be 1k|2k|4k.`);
        }
        result.flags.resolution = v;
        break;
      }
      case "--detail": {
        const v = nextVal(arg);
        if (!ALLOWED_DETAIL.has(v)) {
          throw new Error(`Invalid --detail: ${v}. Must be auto|low|medium|high.`);
        }
        result.flags.detail = v;
        break;
      }
      case "--ref":
        if (!result.flags.ref) result.flags.ref = [];
        result.flags.ref.push(nextVal(arg));
        break;
      case "--edit":
        result.flags.edit = nextVal(arg);
        break;
      case "--mask":
        result.flags.mask = nextVal(arg);
        break;
      case "--outdir":
      case "-o":
        result.flags.outdir = nextVal(arg);
        break;
      case "--json":
        result.flags.json = true;
        break;
      case "--async":
        result.flags.async = true;
        break;
      case "--chain":
        result.flags.chain = true;
        break;
      case "--character":
        result.flags.character = nextVal(arg);
        break;
      default:
        // Unknown flag — skip
        break;
    }
    i++;
  }

  return result;
}
