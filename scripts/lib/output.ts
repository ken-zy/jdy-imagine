import { existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

// Unicode emoji regex (covers most emoji ranges)
const EMOJI_RE =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;

// OS-reserved characters + ASCII control chars
const RESERVED_RE = /[<>:"/\\|?*\x00-\x1F]/g;

// Zero-width characters
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;

export function generateSlug(prompt: string): string {
  // 1. Unicode NFC normalization
  let text = prompt.normalize("NFC");

  // 2. Strip emoji, zero-width, control characters
  text = text.replace(EMOJI_RE, "").replace(ZERO_WIDTH_RE, "");

  // 3. Extract words (split on whitespace and punctuation)
  const words = text
    .split(/[\s\p{P}]+/u)
    .filter((w) => w.length > 0);

  // 4. Take first 4 tokens
  const tokens = words.slice(0, 4);

  // 5. Lowercase, join with -
  let slug = tokens.map((t) => t.toLowerCase()).join("-");

  // 6. Remove OS-reserved characters
  slug = slug.replace(RESERVED_RE, "");

  // 7. Truncate to 40 characters
  slug = slug.slice(0, 40);

  // 8. Strip trailing - and .
  slug = slug.replace(/[-.]+$/, "");

  // 9. Fallback if empty
  if (!slug) slug = "img";

  return slug;
}

export function mimeToExt(mimeType: string): string {
  return mimeType === "image/jpeg" ? ".jpg" : ".png";
}

export function buildOutputPath(
  outdir: string,
  slug: string,
  seq: number,
  ext: string = ".png",
): string {
  const pad = String(seq).padStart(3, "0");
  return join(outdir, `${pad}-${slug}${ext}`);
}

export function resolveOutputPath(
  outdir: string,
  slug: string,
  seq: number,
  ext: string = ".png",
): string {
  let path = buildOutputPath(outdir, slug, seq, ext);
  let suffix = 2;
  while (existsSync(path)) {
    const pad = String(seq).padStart(3, "0");
    path = join(outdir, `${pad}-${slug}-${suffix}${ext}`);
    suffix++;
  }
  return path;
}

export function ensureOutdir(outdir: string): void {
  if (!existsSync(outdir)) {
    mkdirSync(outdir, { recursive: true });
  }
}

export function writeImage(path: string, data: Uint8Array): void {
  writeFileSync(path, data);
}

export function nextSeqNumber(outdir: string): number {
  if (!existsSync(outdir)) return 1;
  let max = 0;
  const files = readdirSync(outdir);
  for (const f of files) {
    if (!f.endsWith(".png") && !f.endsWith(".jpg")) continue;
    const match = f.match(/^(\d+)-/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}
