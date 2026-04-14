import { parseArgs } from "./lib/args";
import { resolveConfig } from "./lib/config";
import { createGoogleProvider } from "./providers/google";
import { runGenerate } from "./commands/generate";
import type { Provider } from "./providers/types";

const PROVIDERS: Record<string, (apiKey: string, baseUrl: string) => Provider> = {
  google: createGoogleProvider,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig({
    model: args.flags.model,
    provider: args.flags.provider,
    ar: args.flags.ar,
    quality: args.flags.quality,
  });

  // Validate API key
  if (!config.apiKey) {
    console.error(
      "Missing API key. Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable,\n" +
      "or create a .env file at .jdy-imagine/.env or ~/.jdy-imagine/.env",
    );
    process.exit(1);
  }

  // Create provider
  const providerFactory = PROVIDERS[config.provider];
  if (!providerFactory) {
    console.error(`Unknown provider: ${config.provider}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
    process.exit(1);
  }
  const provider = providerFactory(config.apiKey, config.baseUrl);

  switch (args.command) {
    case "generate":
      await runGenerate(provider, config, {
        prompt: args.flags.prompt,
        prompts: args.flags.prompts,
        ref: args.flags.ref,
        outdir: args.flags.outdir,
        json: args.flags.json,
      });
      break;

    case "batch": {
      const { runBatch } = await import("./commands/batch");
      await runBatch(provider, config, args);
      break;
    }

    default:
      console.error(
        "Usage: bun scripts/main.ts <command> [options]\n\n" +
        "Commands:\n" +
        "  generate   Generate images in realtime\n" +
        "  batch      Batch image generation (submit/status/fetch/list/cancel)\n",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
