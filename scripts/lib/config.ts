import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { assertAr, assertResolution, assertDetail, type Resolution, type Detail } from "./validators";

export interface Config {
  provider: string;
  model: string;
  resolution: Resolution;
  detail: Detail;
  ar: string;
  apiKey: string;
  baseUrl: string;
}

const DEFAULTS = {
  provider: "google",
  resolution: "2k" as const,
  detail: "high" as const,
  ar: "1:1",
};

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; defaultModel: string }> = {
  google: {
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-3.1-flash-image-preview",
  },
  openai: {
    baseUrl: "https://api.openai.com",
    defaultModel: "gpt-image-2",
  },
  apimart: {
    baseUrl: "https://api.apimart.ai",
    defaultModel: "gpt-image-2-official",
  },
};

export const QUALITY_REMOVED_MSG =
  "--quality / default_quality / prompts.json 'quality' field has been removed.\n" +
  "Migration:\n" +
  "  --quality normal → --resolution 1k --detail medium\n" +
  "  --quality 2k     → --resolution 2k --detail high\n" +
  "EXTEND.md default_quality:\n" +
  "  default_quality: normal → default_resolution: 1k + default_detail: medium\n" +
  "  default_quality: 2k     → default_resolution: 2k + default_detail: high";

export function parseExtendMd(
  content: string,
): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (kv) result[kv[1]] = kv[2];
  }
  return result;
}

export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

export function mergeConfig(
  cliFlags: Record<string, string | undefined>,
  extendMd: Record<string, string>,
  env: Record<string, string | undefined>,
): Config {
  if (extendMd.default_quality !== undefined) {
    throw new Error(QUALITY_REMOVED_MSG);
  }
  const provider =
    cliFlags.provider ??
    extendMd.default_provider ??
    DEFAULTS.provider;

  const providerDefault = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.google;

  let apiKey = "";
  let baseUrl = providerDefault.baseUrl;
  let envModel: string | undefined;

  if (provider === "google") {
    apiKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY ?? "";
    baseUrl = env.GOOGLE_BASE_URL ?? baseUrl;
    envModel = env.GOOGLE_IMAGE_MODEL;
  } else if (provider === "openai") {
    apiKey = env.OPENAI_API_KEY ?? "";
    baseUrl = env.OPENAI_BASE_URL ?? baseUrl;
    envModel = env.OPENAI_IMAGE_MODEL;
  } else if (provider === "apimart") {
    apiKey = env.APIMART_API_KEY ?? "";
    baseUrl = env.APIMART_BASE_URL ?? baseUrl;
    envModel = env.APIMART_IMAGE_MODEL;
  }

  // Validate every untrusted entry point. CLI flags are pre-validated by parseArgs,
  // but EXTEND.md front matter is not — and a silent type-cast lets garbage like
  // `default_resolution: 3k` flow into Google's deriveImageSize as an undefined
  // bucket that falls through to "2K", producing the wrong size with no warning.
  let resolutionRaw: string = DEFAULTS.resolution;
  if (cliFlags.resolution !== undefined) {
    resolutionRaw = cliFlags.resolution;
  } else if (extendMd.default_resolution !== undefined) {
    assertResolution(extendMd.default_resolution, "EXTEND.md default_resolution");
    resolutionRaw = extendMd.default_resolution;
  }
  assertResolution(resolutionRaw, "resolution");

  let detailRaw: string = DEFAULTS.detail;
  if (cliFlags.detail !== undefined) {
    detailRaw = cliFlags.detail;
  } else if (extendMd.default_detail !== undefined) {
    assertDetail(extendMd.default_detail, "EXTEND.md default_detail");
    detailRaw = extendMd.default_detail;
  }
  assertDetail(detailRaw, "detail");

  let arRaw: string = DEFAULTS.ar;
  if (cliFlags.ar !== undefined) {
    arRaw = cliFlags.ar;
  } else if (extendMd.default_ar !== undefined) {
    assertAr(extendMd.default_ar, "EXTEND.md default_ar");
    arRaw = extendMd.default_ar;
  }
  assertAr(arRaw, "ar");

  return {
    provider,
    model:
      cliFlags.model ??
      extendMd.default_model ??
      envModel ??
      providerDefault.defaultModel,
    resolution: resolutionRaw,
    detail: detailRaw,
    ar: arRaw,
    apiKey,
    baseUrl,
  };
}

export function loadDotEnvFile(): Record<string, string> {
  const paths = [
    join(process.cwd(), ".jdy-imagine", ".env"),
    join(process.env.HOME ?? "", ".jdy-imagine", ".env"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      return parseDotEnv(readFileSync(p, "utf-8"));
    }
  }
  return {};
}

export function loadExtendMd(): Record<string, string> {
  const paths = [
    join(process.cwd(), ".jdy-imagine", "EXTEND.md"),
    join(process.env.HOME ?? "", ".config", "jdy-imagine", "EXTEND.md"),
    join(process.env.HOME ?? "", ".jdy-imagine", "EXTEND.md"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      return parseExtendMd(readFileSync(p, "utf-8"));
    }
  }
  return {};
}

export function resolveConfig(
  cliFlags: Record<string, string | undefined>,
): Config {
  const dotEnv = loadDotEnvFile();
  for (const [k, v] of Object.entries(dotEnv)) {
    if (!(k in process.env)) {
      process.env[k] = v;
    }
  }
  const extendMd = loadExtendMd();
  return mergeConfig(cliFlags, extendMd, process.env as Record<string, string>);
}
