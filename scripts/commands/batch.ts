import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import type { Provider, GenerateRequest, BatchResult } from "../providers/types";
import { type Config, QUALITY_REMOVED_MSG } from "../lib/config";
import type { ParsedArgs } from "../lib/args";
import { generateSlug, ensureOutdir, writeImage, mimeToExt } from "../lib/output";
import { loadCharacter, applyCharacterPrompt, mergeCharacterRefs } from "../lib/character";

export const BATCH_PAYLOAD_LIMIT = 100 * 1024 * 1024;

export interface BatchManifest {
  jobId: string;
  model: string;
  createTime: string;
  outdir: string;
  tasks: Array<{
    key: string;
    prompt: string;
    ar?: string;
    resolution?: "1k" | "2k" | "4k";
    detail?: "auto" | "low" | "medium" | "high";
  }>;
}

/**
 * Validate that batch tasks are compatible with the chosen provider.
 *
 * Currently the only restriction is OpenAI server-side batch being text-only:
 * it cannot accept image inputs (refs / editTarget / mask). character profile
 * injects refs into every task, so it triggers this restriction too.
 */
export function validateBatchTasks(providerName: string, tasks: GenerateRequest[]): void {
  if (providerName !== "openai") return;
  const offending = tasks.filter(t =>
    t.refs.length > 0 || t.editTarget || t.mask
  );
  if (offending.length > 0) {
    throw new Error(
      `OpenAI server-side batch is text-only. ${offending.length} task(s) have image inputs ` +
      `(refs / editTarget / mask). Note: --character profile injects refs into all tasks, which also ` +
      `triggers this restriction. Either remove image inputs or use realtime mode.`,
    );
  }
}

export function saveManifest(outdir: string, manifest: BatchManifest): void {
  const dir = join(outdir, ".jdy-imagine-batch");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filename = manifest.jobId.replace(/\//g, "_") + ".json";
  writeFileSync(join(dir, filename), JSON.stringify(manifest, null, 2));
}

export function loadManifest(
  outdir: string,
  jobId: string,
): BatchManifest | null {
  const dir = join(outdir, ".jdy-imagine-batch");
  const filename = jobId.replace(/\//g, "_") + ".json";
  const path = join(dir, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export async function runBatch(
  provider: Provider,
  config: Config,
  args: ParsedArgs,
): Promise<void> {
  const sub = args.subcommand;

  if (!sub) {
    console.error(
      "Usage: bun scripts/main.ts batch <submit|status|fetch|list|cancel> [args]",
    );
    process.exit(1);
  }

  switch (sub) {
    case "submit":
      await batchSubmit(provider, config, args);
      break;
    case "status":
      await batchStatus(provider, args);
      break;
    case "fetch":
      await batchFetch(provider, config, args);
      break;
    case "list":
      await batchList(provider, args);
      break;
    case "cancel":
      await batchCancel(provider, args);
      break;
    default:
      console.error(`Unknown batch subcommand: ${sub}`);
      process.exit(1);
  }
}

async function batchSubmit(
  provider: Provider,
  config: Config,
  args: ParsedArgs,
): Promise<void> {
  if (!provider.batchCreate) {
    throw new Error(`Provider ${provider.name} does not support batch operations`);
  }

  if (!args.positional) {
    throw new Error("Usage: batch submit <prompts.json> [--outdir dir] [--async]");
  }

  // Warn if --chain used with batch
  if (args.flags.chain) {
    console.error(
      "Warning: --chain is not supported in batch mode (each request is independent). Ignored.",
    );
  }

  // Load character profile if specified
  const character = args.flags.character
    ? loadCharacter(resolve(args.flags.character))
    : null;

  const filePath = resolve(args.positional);
  const content = readFileSync(filePath, "utf-8");
  const rawTasks = JSON.parse(content) as Array<{
    prompt: string;
    ar?: string;
    quality?: string;
    resolution?: "1k" | "2k" | "4k";
    detail?: "auto" | "low" | "medium" | "high";
    ref?: string[];
  }>;

  // Migrate: prompts.json `quality` field is removed.
  for (const t of rawTasks) {
    if ("quality" in t && t.quality !== undefined) {
      throw new Error(QUALITY_REMOVED_MSG);
    }
  }

  const dir = dirname(filePath);
  const tasks: GenerateRequest[] = rawTasks.map((t) => {
    let prompt = t.prompt;
    let refs = t.ref?.map((r) => resolve(dir, r)) ?? [];

    // Apply character profile
    if (character) {
      prompt = applyCharacterPrompt(prompt, character);
      refs = mergeCharacterRefs(refs, character);
    }

    const resolution = (t.resolution ?? config.resolution) as "1k" | "2k" | "4k";
    const detail = (t.detail ?? config.detail) as "auto" | "low" | "medium" | "high";

    return {
      prompt,
      model: config.model,
      ar: t.ar ?? config.ar,
      resolution,
      detail,
      refs,
    };
  });

  // Provider-specific compatibility check (e.g., OpenAI batch is text-only)
  validateBatchTasks(provider.name, tasks);

  // Payload estimation guardrail (total: character refs + task refs + prompts per task)
  {
    const BASE64_OVERHEAD = 1.37;
    const JSON_OVERHEAD_PER_TASK = 512; // JSON structure, metadata keys, etc.
    let totalEstimate = 0;
    for (const task of tasks) {
      // Refs for this task (includes character refs if merged)
      let taskRefBytes = 0;
      for (const refPath of task.refs) {
        taskRefBytes += readFileSync(refPath).length;
      }
      totalEstimate += taskRefBytes * BASE64_OVERHEAD;
      totalEstimate += Buffer.byteLength(task.prompt, "utf-8");
      totalEstimate += JSON_OVERHEAD_PER_TASK;
    }
    if (totalEstimate > BATCH_PAYLOAD_LIMIT) {
      const charRefNote = character
        ? ` Character references are duplicated across all ${tasks.length} tasks — consider removing them or reducing tasks per batch.`
        : "";
      throw new Error(
        `Estimated batch payload (~${Math.round(totalEstimate / 1024 / 1024)}MB) exceeds 100MB limit.${charRefNote}`,
      );
    }
  }

  const outdir = args.flags.outdir;
  ensureOutdir(outdir);

  const job = await provider.batchCreate({
    model: config.model,
    tasks,
    displayName: `jdy-imagine-${Date.now()}`,
  });

  const manifestTasks = tasks.map((t, i) => {
    const seq = String(i + 1).padStart(3, "0");
    const slug = generateSlug(t.prompt);
    return {
      key: `${seq}-${slug}`,
      prompt: t.prompt,
      ar: t.ar ?? undefined,
      resolution: t.resolution,
      detail: t.detail,
    };
  });

  const manifest: BatchManifest = {
    jobId: job.id,
    model: config.model,
    createTime: job.createTime,
    outdir: resolve(outdir),
    tasks: manifestTasks,
  };
  saveManifest(outdir, manifest);

  if (args.flags.async) {
    if (args.flags.json) {
      console.log(JSON.stringify({ jobId: job.id, state: job.state }));
    } else {
      console.log(`Job submitted: ${job.id}`);
      console.log(`Check status: bun scripts/main.ts batch status ${job.id}`);
    }
    return;
  }

  console.log(`Job submitted: ${job.id}. Waiting for completion...`);
  await pollAndFetch(provider, config, job.id, outdir, args.flags.json, manifest);
}

async function pollAndFetch(
  provider: Provider,
  _config: Config,
  jobId: string,
  outdir: string,
  jsonOutput: boolean,
  manifest: BatchManifest | null,
): Promise<void> {
  if (!provider.batchGet || !provider.batchFetch) {
    throw new Error("Provider does not support batch get/fetch");
  }

  const startTime = Date.now();
  const MAX_WAIT = 48 * 60 * 60 * 1000;
  let pollInterval = 5000;
  const INCREASE_AFTER = 60_000;

  while (true) {
    const job = await provider.batchGet(jobId);

    if (job.state === "succeeded") {
      const results = await provider.batchFetch(jobId);
      const { written, failed } = writeResults(results, outdir, jsonOutput, manifest);
      if (written === 0 && failed > 0) {
        process.exit(1);
      }
      return;
    }

    if (job.state === "failed") {
      console.error(`Batch job failed.`);
      if (job.stats) {
        console.error(`Stats: ${job.stats.succeeded} succeeded, ${job.stats.failed} failed`);
      }
      process.exit(1);
    }

    if (job.state === "cancelled") {
      console.error("Batch job was cancelled.");
      process.exit(1);
    }

    if (job.state === "expired") {
      console.error("Batch job expired (48h server-side limit). Resubmit the job.");
      process.exit(1);
    }

    if (Date.now() - startTime > MAX_WAIT) {
      console.error("Batch job timed out after 48 hours. Resubmit the job.");
      process.exit(1);
    }

    if (Date.now() - startTime > INCREASE_AFTER) {
      pollInterval = 15000;
    }

    await Bun.sleep(pollInterval);
  }
}

export function writeResults(
  results: BatchResult[],
  outdir: string,
  jsonOutput: boolean,
  manifest: BatchManifest | null,
): { written: number; failed: number } {
  ensureOutdir(outdir);
  let written = 0;
  let failed = 0;

  for (const r of results) {
    if (r.error) {
      if (jsonOutput) {
        console.log(JSON.stringify({ key: r.key, error: r.error }));
      } else {
        console.error(`[${r.key}] Error: ${r.error}`);
      }
      failed++;
      continue;
    }

    if (!r.result || r.result.images.length === 0) {
      const msg = r.result?.finishReason === "SAFETY"
        ? `Safety block: ${r.result.safetyInfo?.reason ?? "unknown"}`
        : r.result?.finishReason === "ERROR"
        ? `Error: ${r.result.safetyInfo?.reason ?? "unknown"}`
        : "No image generated";
      if (jsonOutput) {
        console.log(JSON.stringify({ key: r.key, error: msg }));
      } else {
        console.error(`[${r.key}] ${msg}`);
      }
      failed++;
      continue;
    }

    const manifestTask = manifest?.tasks.find((t) => t.key === r.key);
    const baseKey = r.key;

    for (let imgIdx = 0; imgIdx < r.result.images.length; imgIdx++) {
      const img = r.result.images[imgIdx];
      const ext = mimeToExt(img.mimeType);
      const imgKey = r.result.images.length > 1
        ? `${baseKey}-${String.fromCharCode(97 + imgIdx)}`
        : baseKey;
      // Collision handling
      let outPath = join(outdir, `${imgKey}${ext}`);
      let collisionSuffix = 2;
      while (existsSync(outPath)) {
        outPath = join(outdir, `${imgKey}-${collisionSuffix}${ext}`);
        collisionSuffix++;
      }
      writeImage(outPath, img.data);
      written++;

      if (jsonOutput) {
        console.log(JSON.stringify({
          key: r.key,
          path: outPath,
          prompt: manifestTask?.prompt,
        }));
      } else {
        console.log(outPath);
      }
    }
  }

  if (!jsonOutput) {
    console.log(`\n${written} image(s) saved to ${outdir}`);
    if (failed > 0) {
      console.error(`${failed} task(s) failed`);
    }
  }

  return { written, failed };
}

async function batchStatus(
  provider: Provider,
  args: ParsedArgs,
): Promise<void> {
  if (!provider.batchGet) {
    throw new Error("Provider does not support batch operations");
  }
  if (!args.positional) {
    throw new Error("Usage: batch status <jobId>");
  }

  const job = await provider.batchGet(args.positional);

  if (args.flags.json) {
    console.log(JSON.stringify(job));
  } else {
    console.log(`Job: ${job.id}`);
    console.log(`State: ${job.state}`);
    console.log(`Created: ${job.createTime}`);
    if (job.stats) {
      console.log(
        `Progress: ${job.stats.succeeded}/${job.stats.total} succeeded, ${job.stats.failed} failed`,
      );
    }
  }
}

async function batchFetch(
  provider: Provider,
  _config: Config,
  args: ParsedArgs,
): Promise<void> {
  if (!provider.batchFetch) {
    throw new Error("Provider does not support batch fetch");
  }
  if (!args.positional) {
    throw new Error("Usage: batch fetch <jobId> --outdir <dir>");
  }

  const outdir = args.flags.outdir;
  const manifest = loadManifest(outdir, args.positional);
  if (!manifest) {
    console.error(
      `Warning: No local manifest found for ${args.positional}. Output naming may differ from original submission.`,
    );
  }

  // Verify job is complete before fetching results
  if (provider.batchGet) {
    const job = await provider.batchGet(args.positional);
    if (job.state !== "succeeded") {
      console.error(
        `Job ${args.positional} is not complete (state: ${job.state}).` +
        (job.state === "failed" ? " Job failed." :
         job.state === "expired" ? " Job expired. Resubmit." :
         " Wait for completion or use `batch status` to check."),
      );
      process.exit(1);
    }
  }

  const results = await provider.batchFetch(args.positional);
  const { written, failed } = writeResults(results, outdir, args.flags.json, manifest);

  // Exit with non-zero if all results failed
  if (written === 0 && failed > 0) {
    process.exit(1);
  }
}

async function batchList(
  provider: Provider,
  args: ParsedArgs,
): Promise<void> {
  if (!provider.batchList) {
    throw new Error("Provider does not support batch list");
  }

  const jobs = await provider.batchList();

  if (args.flags.json) {
    console.log(JSON.stringify(jobs));
  } else {
    if (jobs.length === 0) {
      console.log("No batch jobs found.");
      return;
    }
    for (const job of jobs) {
      const manifest = loadManifest(args.flags.outdir, job.id);
      const info = manifest
        ? ` (${manifest.tasks.length} tasks, outdir: ${manifest.outdir})`
        : "";
      console.log(`${job.id}  ${job.state}  ${job.createTime}${info}`);
    }
  }
}

async function batchCancel(
  provider: Provider,
  args: ParsedArgs,
): Promise<void> {
  if (!provider.batchCancel) {
    throw new Error("Provider does not support batch cancel");
  }
  if (!args.positional) {
    throw new Error("Usage: batch cancel <jobId>");
  }

  await provider.batchCancel(args.positional);
  console.log(`Job ${args.positional} cancelled.`);
}
