import { parseArgs } from "./lib/args";
import { resolveConfig } from "./lib/config";
import { createGoogleProvider } from "./providers/google";
import { createOpenAIProvider } from "./providers/openai";
import { runGenerate } from "./commands/generate";
import type { ProviderConfig, ProviderFactory } from "./providers/types";

const PROVIDERS: Record<string, ProviderFactory> = {
  google: createGoogleProvider,
  openai: createOpenAIProvider,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig({
    model: args.flags.model,
    provider: args.flags.provider,
    ar: args.flags.ar,
    resolution: args.flags.resolution,
    detail: args.flags.detail,
  });

  // Validate API key
  if (!config.apiKey) {
    const envName = config.provider === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY";
    console.error(
      `Missing API key. Set ${envName} environment variable,\n` +
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
  const providerConfig: ProviderConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  };
  const provider = providerFactory(providerConfig);

  // Defensive fallback: if config.model is empty (no CLI/env/default), use provider.defaultModel.
  // In normal flow mergeConfig fills this, but providers may declare richer defaults.
  if (!config.model) {
    config.model = provider.defaultModel;
  }

  switch (args.command) {
    case "generate":
      await runGenerate(provider, config, {
        prompt: args.flags.prompt,
        prompts: args.flags.prompts,
        ref: args.flags.ref,
        edit: args.flags.edit,
        mask: args.flags.mask,
        outdir: args.flags.outdir,
        json: args.flags.json,
        character: args.flags.character,
        chain: args.flags.chain,
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
