import type { Provider, ProviderConfig } from "./types";

// Placeholder factory — real implementation lands in Task 2.3 (text-only path)
// and Task 2.4 (image input + sha256 cache). Registering here keeps `--provider apimart`
// from tripping the unknown-provider error during incremental builds and lets the
// API-key error path advertise APIMART_API_KEY.
export function createApimartProvider(_config: ProviderConfig): Provider {
  return {
    name: "apimart",
    defaultModel: "gpt-image-2-official",
    generate: async () => {
      throw new Error("apimart provider not yet implemented (placeholder)");
    },
  };
}
