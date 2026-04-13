import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface Config {
  provider: string;
  model: string;
  quality: "normal" | "2k";
  ar: string;
  apiKey: string;
  baseUrl: string;
}

const DEFAULTS: Config = {
  provider: "google",
  model: "gemini-3.1-flash-image-preview",
  quality: "2k",
  ar: "1:1",
  apiKey: "",
  baseUrl: "https://generativelanguage.googleapis.com",
};

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
    result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return result;
}

export function mergeConfig(
  cliFlags: Record<string, string | undefined>,
  extendMd: Record<string, string>,
  env: Record<string, string | undefined>,
): Config {
  return {
    provider:
      cliFlags.provider ??
      extendMd.default_provider ??
      DEFAULTS.provider,
    model:
      cliFlags.model ??
      extendMd.default_model ??
      env.GOOGLE_IMAGE_MODEL ??
      DEFAULTS.model,
    quality: (cliFlags.quality ??
      extendMd.default_quality ??
      DEFAULTS.quality) as "normal" | "2k",
    ar:
      cliFlags.ar ??
      extendMd.default_ar ??
      DEFAULTS.ar,
    apiKey:
      env.GOOGLE_API_KEY ??
      env.GEMINI_API_KEY ??
      DEFAULTS.apiKey,
    baseUrl:
      env.GOOGLE_BASE_URL ??
      DEFAULTS.baseUrl,
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
