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
import { type Config, QUALITY_REMOVED_MSG } from "../lib/config";
import { assertAr, assertResolution, assertDetail, type Resolution, type Detail } from "../lib/validators";
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
  // mask is now a capability flag — providers self-reject (google.rejectMask). The old
  // `provider.name !== "openai"` check has been removed (apimart also supports mask).
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
  resolution?: Resolution;
  detail?: Detail;
  refs: string[];
}

export function loadPrompts(
  flags: GenerateFlags,
  defaults: {
    model: string;
    ar: string;
    resolution: Resolution;
    detail: Detail;
    refs: string[];
  },
): PromptTask[] {
  if (flags.prompt) {
    return [
      {
        prompt: flags.prompt,
        ar: defaults.ar,
        resolution: defaults.resolution,
        detail: defaults.detail,
        refs: flags.ref ?? defaults.refs,
      },
    ];
  }

  const filePath = resolve(flags.prompts!);
  const content = readFileSync(filePath, "utf-8");
  const tasks = JSON.parse(content) as Array<{
    prompt: string;
    ar?: string;
    quality?: string;
    resolution?: string;
    detail?: string;
    ref?: string[];
  }>;

  // Migrate: prompts.json `quality` field is removed. Throw with QUALITY_REMOVED_MSG.
  for (const t of tasks) {
    if ("quality" in t && t.quality !== undefined) {
      throw new Error(QUALITY_REMOVED_MSG);
    }
  }

  const dir = dirname(filePath);
  return tasks.map((t, idx) => {
    if (t.ar !== undefined) assertAr(t.ar, `prompts.json[${idx}].ar`);
    if (t.resolution !== undefined) assertResolution(t.resolution, `prompts.json[${idx}].resolution`);
    if (t.detail !== undefined) assertDetail(t.detail, `prompts.json[${idx}].detail`);
    return {
      prompt: t.prompt,
      ar: t.ar ?? defaults.ar,
      resolution: (t.resolution as Resolution | undefined) ?? defaults.resolution,
      detail: (t.detail as Detail | undefined) ?? defaults.detail,
      refs: t.ref?.map((r) => resolve(dir, r)) ?? defaults.refs,
    };
  });
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
    resolution: config.resolution,
    detail: config.detail,
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

  // Build all GenerateRequests up front for fail-fast preflight (refs already merged).
  // resolution/detail were already validated in loadPrompts → safe to read directly.
  const builtReqs: GenerateRequest[] = tasks.map((task) => ({
    prompt: task.prompt,
    model: config.model,
    ar: task.ar ?? null,
    resolution: task.resolution ?? config.resolution,
    detail: task.detail ?? config.detail,
    refs: task.refs,
    editTarget: flags.edit,
    mask: flags.mask,
  }));

  // Fail-fast preflight: 16-image cap on final merged refs, plus provider self-check.
  for (const req of builtReqs) {
    const totalImages = req.refs.length + (req.editTarget ? 1 : 0);
    if (totalImages > 16) {
      throw new Error(
        `Task with prompt "${req.prompt.slice(0, 40)}" has ${totalImages} image inputs ` +
          `(refs + editTarget). Maximum is 16.`,
      );
    }
    provider.validateRequest?.(req);
  }

  let anchor: ChainAnchor | undefined;
  let hasAnchor = false;

  let seq = nextSeqNumber(flags.outdir);

  for (let taskIdx = 0; taskIdx < tasks.length; taskIdx++) {
    const task = tasks[taskIdx];
    const isFirstTask = taskIdx === 0;
    const req: GenerateRequest = builtReqs[taskIdx];

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
