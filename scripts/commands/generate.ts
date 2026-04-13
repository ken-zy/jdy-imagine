import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import type { GenerateRequest, Provider } from "../providers/types";
import {
  generateSlug,
  resolveOutputPath,
  ensureOutdir,
  writeImage,
  nextSeqNumber,
  mimeToExt,
} from "../lib/output";
import type { Config } from "../lib/config";
import { mapQualityToImageSize } from "../providers/google";

export interface GenerateFlags {
  prompt?: string;
  prompts?: string;
  ref?: string[];
}

export function validateGenerateArgs(flags: GenerateFlags): void {
  if (!flags.prompt && !flags.prompts) {
    throw new Error("--prompt or --prompts is required");
  }
  if (flags.prompt && flags.prompts) {
    throw new Error("Cannot use both --prompt and --prompts");
  }
}

interface PromptTask {
  prompt: string;
  ar?: string;
  quality?: "normal" | "2k";
  refs: string[];
}

export function loadPrompts(
  flags: GenerateFlags,
  defaults: { model: string; ar: string; quality: "normal" | "2k"; refs: string[] },
): PromptTask[] {
  if (flags.prompt) {
    return [
      {
        prompt: flags.prompt,
        ar: defaults.ar,
        quality: defaults.quality,
        refs: flags.ref ?? defaults.refs,
      },
    ];
  }

  // Load from prompts.json
  const filePath = resolve(flags.prompts!);
  const content = readFileSync(filePath, "utf-8");
  const tasks = JSON.parse(content) as Array<{
    prompt: string;
    ar?: string;
    quality?: "normal" | "2k";
    ref?: string[];
  }>;

  const dir = dirname(filePath);
  return tasks.map((t) => ({
    prompt: t.prompt,
    ar: t.ar ?? defaults.ar,
    quality: t.quality ?? defaults.quality,
    refs: t.ref?.map((r) => resolve(dir, r)) ?? defaults.refs,
  }));
}

export async function runGenerate(
  provider: Provider,
  config: Config,
  flags: {
    prompt?: string;
    prompts?: string;
    ref?: string[];
    outdir: string;
    json: boolean;
  },
): Promise<void> {
  validateGenerateArgs(flags);
  ensureOutdir(flags.outdir);

  const tasks = loadPrompts(flags, {
    model: config.model,
    ar: config.ar,
    quality: config.quality,
    refs: flags.ref?.map((r) => resolve(r)) ?? [],
  });

  let seq = nextSeqNumber(flags.outdir);

  for (const task of tasks) {
    const req: GenerateRequest = {
      prompt: task.prompt,
      model: config.model,
      ar: task.ar ?? null,
      quality: task.quality ?? config.quality,
      refs: task.refs,
      imageSize: mapQualityToImageSize(task.quality ?? config.quality),
    };

    const result = await provider.generate(req);

    // Handle safety block
    if (result.finishReason === "SAFETY") {
      const msg = result.safetyInfo
        ? `Safety block: ${result.safetyInfo.category} — ${result.safetyInfo.reason}`
        : "Content blocked by safety filter";
      if (flags.json) {
        console.log(JSON.stringify({ error: msg, finishReason: "SAFETY", safetyInfo: result.safetyInfo }));
      } else {
        console.error(msg);
      }
      process.exit(1);
    }

    // Handle no images
    if (result.images.length === 0) {
      const msg = result.textParts?.length
        ? `Model returned text instead of image: ${result.textParts[0]}`
        : "No image generated";
      if (flags.json) {
        console.log(JSON.stringify({ error: msg, textParts: result.textParts }));
      } else {
        console.error(msg);
      }
      process.exit(1);
    }

    // Write images
    const slug = generateSlug(task.prompt);
    for (let imgIdx = 0; imgIdx < result.images.length; imgIdx++) {
      const img = result.images[imgIdx];
      const ext = mimeToExt(img.mimeType);
      const imgSlug = result.images.length > 1
        ? `${slug}-${String.fromCharCode(97 + imgIdx)}` // -a, -b, -c
        : slug;
      const outPath = resolveOutputPath(flags.outdir, imgSlug, seq, ext);
      writeImage(outPath, img.data);

      if (flags.json) {
        console.log(
          JSON.stringify({
            path: outPath,
            prompt: task.prompt,
            mimeType: img.mimeType,
            finishReason: result.finishReason,
          }),
        );
      } else {
        console.log(outPath);
      }
    }
    seq++;
  }
}
