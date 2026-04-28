import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import type { GenerateRequest, GenerateResult, Provider, ChainAnchor } from "../providers/types";
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
import { loadCharacter, applyCharacterPrompt, mergeCharacterRefs, type CharacterProfile } from "../lib/character";

export interface GenerateFlags {
  prompt?: string;
  prompts?: string;
  ref?: string[];
  character?: string;   // NEW
  chain?: boolean;       // NEW
}

export function validateGenerateArgs(flags: GenerateFlags): void {
  if (!flags.prompt && !flags.prompts) {
    throw new Error("--prompt or --prompts is required");
  }
  if (flags.prompt && flags.prompts) {
    throw new Error("Cannot use both --prompt and --prompts");
  }
}

/**
 * Provider-specific capability check, executed before any tasks run.
 * Surfaces incompatible flag combinations as a single early error rather
 * than letting them fail mid-loop with a confusing message.
 */
export function validateProviderCapabilities(
  provider: Provider,
  flags: { mask?: string; edit?: string; ref?: string[]; chain?: boolean },
): void {
  if (flags.mask && provider.name !== "openai") {
    throw new Error(`--mask is supported only by openai provider (got: ${provider.name})`);
  }
  if (flags.mask && !flags.edit && (!flags.ref || flags.ref.length === 0)) {
    throw new Error("--mask requires --edit or --ref to specify the image being masked");
  }
  if (flags.chain && !provider.generateChained) {
    throw new Error(`Provider ${provider.name} does not support chain mode`);
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

// No hidden contracts — generateAndAnchor is in the public Provider interface

export async function runGenerate(
  provider: Provider,
  config: Config,
  flags: {
    prompt?: string;
    prompts?: string;
    ref?: string[];
    edit?: string;
    mask?: string;
    outdir: string;
    json: boolean;
    character?: string;
    chain?: boolean;
  },
): Promise<void> {
  validateGenerateArgs(flags);
  validateProviderCapabilities(provider, flags);
  ensureOutdir(flags.outdir);

  // Load character profile if specified
  const character = flags.character
    ? loadCharacter(resolve(flags.character))
    : null;

  const tasks = loadPrompts(flags, {
    model: config.model,
    ar: config.ar,
    quality: config.quality,
    refs: flags.ref?.map((r) => resolve(r)) ?? [],
  });

  // Resolve all refs to absolute paths FIRST (before dedup in mergeCharacterRefs)
  for (const task of tasks) {
    task.refs = task.refs.map((r) => resolve(r));
  }

  // Apply character: prompt injection for ALL tasks, ref injection depends on chain mode
  const useChain = flags.chain === true && tasks.length > 1;
  if (character) {
    for (let i = 0; i < tasks.length; i++) {
      // Always inject description + negative into prompt
      tasks[i].prompt = applyCharacterPrompt(tasks[i].prompt, character);
      // Merge character refs: always for non-chain, only first task for chain
      if (!useChain || i === 0) {
        tasks[i].refs = mergeCharacterRefs(tasks[i].refs, character);
      }
      // Chain tasks 2..N: character refs are already in anchor's firstUserParts
      // Only task-specific refs (from prompts.json "ref" field) are sent
    }
  }

  let anchor: ChainAnchor | undefined;
  let hasAnchor = false;

  let seq = nextSeqNumber(flags.outdir);

  for (let taskIdx = 0; taskIdx < tasks.length; taskIdx++) {
    const task = tasks[taskIdx];
    const isFirstTask = taskIdx === 0;

    const req: GenerateRequest = {
      prompt: task.prompt,
      model: config.model,
      ar: task.ar ?? null,
      quality: task.quality ?? config.quality,
      refs: task.refs,
      imageSize: mapQualityToImageSize(task.quality ?? config.quality),
      editTarget: flags.edit,
      mask: flags.mask,
    };

    let result: GenerateResult;

    if (useChain && !isFirstTask && hasAnchor) {
      // Chained generation: use anchor
      if (!provider.generateChained) {
        throw new Error(`Provider ${provider.name} does not support chain mode`);
      }
      try {
        result = await provider.generateChained(req, anchor);
      } catch (err) {
        // Subsequent task failure: skip and continue
        const msg = err instanceof Error ? err.message : String(err);
        if (flags.json) {
          console.log(JSON.stringify({ error: msg, prompt: task.prompt, skipped: true }));
        } else {
          console.error(`[skip] ${task.prompt.slice(0, 60)}... — ${msg}`);
        }
        continue;
      }
    } else if (useChain && isFirstTask) {
      // First task in chain: generate + create anchor in one call
      if (!provider.generateAndAnchor) {
        throw new Error(`Provider ${provider.name} does not support chain mode`);
      }
      const { result: firstResult, anchor: newAnchor } =
        await provider.generateAndAnchor(req);
      result = firstResult;

      // First image guard
      if (result.finishReason === "SAFETY" || result.images.length === 0) {
        const msg = result.safetyInfo
          ? `Chain aborted: first image generation failed — ${result.safetyInfo.reason}`
          : "Chain aborted: first image generation failed (no image returned)";
        if (flags.json) {
          console.log(JSON.stringify({ error: msg, finishReason: result.finishReason }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }
      if (result.images.length > 1) {
        const msg =
          "Chain aborted: first task returned multiple images, cannot determine anchor. Use a more specific prompt for the first task.";
        if (flags.json) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(msg);
        }
        process.exit(1);
      }

      anchor = newAnchor;
      hasAnchor = true;
    } else {
      // Normal (non-chain) generation
      result = await provider.generate(req);
    }

    // Handle safety block (non-chain or first-task already handled above)
    if (result.finishReason === "SAFETY") {
      const msg = result.safetyInfo
        ? `Safety block: ${result.safetyInfo.category ?? "unknown category"} — ${result.safetyInfo.reason}`
        : "Content blocked by safety filter";
      if (flags.json) {
        console.log(
          JSON.stringify({
            error: msg,
            finishReason: "SAFETY",
            safetyInfo: result.safetyInfo,
          }),
        );
      } else {
        console.error(msg);
      }
      if (!useChain) process.exit(1);
      continue; // In chain mode for non-first tasks, skip
    }

    // Handle ERROR finishReason (provider returned a non-safety failure as a result)
    if (result.finishReason === "ERROR") {
      const msg = result.safetyInfo?.reason ?? "Provider returned error";
      if (flags.json) {
        console.log(JSON.stringify({ error: msg, finishReason: "ERROR" }));
      } else {
        console.error(`Error: ${msg}`);
      }
      if (!useChain) process.exit(1);
      continue;
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
      if (!useChain) process.exit(1);
      continue; // In chain mode for non-first tasks, skip
    }

    // Write images
    const slug = generateSlug(task.prompt);
    for (let imgIdx = 0; imgIdx < result.images.length; imgIdx++) {
      const img = result.images[imgIdx];
      const ext = mimeToExt(img.mimeType);
      const imgSlug =
        result.images.length > 1
          ? `${slug}-${String.fromCharCode(97 + imgIdx)}`
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
