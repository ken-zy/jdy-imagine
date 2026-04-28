/**
 * Runtime allowlists for CLI flag values that flow through multiple entry points
 * (CLI flags, EXTEND.md front matter, prompts.json per-task overrides, batch
 * manifests). Centralizing them here prevents type-cast lies — every untrusted
 * string must pass through assert* before being narrowed to its enum type.
 */

export type Resolution = "1k" | "2k" | "4k";
export type Detail = "auto" | "low" | "medium" | "high";

export const ALLOWED_AR: ReadonlySet<string> = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "2:1", "1:2", "21:9", "9:21",
]);
export const ALLOWED_RESOLUTION: ReadonlySet<string> = new Set(["1k", "2k", "4k"]);
export const ALLOWED_DETAIL: ReadonlySet<string> = new Set(["auto", "low", "medium", "high"]);

export function assertResolution(v: unknown, source: string): asserts v is Resolution {
  if (typeof v !== "string" || !ALLOWED_RESOLUTION.has(v)) {
    throw new Error(`Invalid ${source}: ${String(v)}. Must be 1k|2k|4k.`);
  }
}

export function assertDetail(v: unknown, source: string): asserts v is Detail {
  if (typeof v !== "string" || !ALLOWED_DETAIL.has(v)) {
    throw new Error(`Invalid ${source}: ${String(v)}. Must be auto|low|medium|high.`);
  }
}

export function assertAr(v: unknown, source: string): asserts v is string {
  if (typeof v !== "string" || !ALLOWED_AR.has(v)) {
    throw new Error(`Invalid ${source}: ${String(v)}. Must be one of: ${[...ALLOWED_AR].join(", ")}`);
  }
}
