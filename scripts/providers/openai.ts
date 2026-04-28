import { readFileSync } from "fs";
import { basename } from "path";
import {
  httpPost,
  httpPostMultipart,
  httpGet,
  httpGetText,
  httpPostWithRetry,
  httpGetWithRetry,
  httpPostMultipartWithRetry,
  httpGetTextWithRetry,
  detectProxy,
} from "../lib/http";
import { generateSlug } from "../lib/output";
import type {
  GenerateRequest,
  GenerateResult,
  BatchCreateRequest,
  BatchJob,
  BatchResult,
  Provider,
  ProviderConfig,
} from "./types";

// === Mappings ===

// Each (quality, ar) maps to a true-aspect-ratio WIDTHxHEIGHT that satisfies
// gpt-image-2 constraints (both edges multiples of 16, total pixels in
// [655_360, 8_294_400], max edge ≤ 3840, long:short ≤ 3:1).
//
// Note: 16:9 and 9:16 are real 1.778:1 ratios (1536x864 / 864x1536) rather than
// being silently degraded to 3:2 (1536x1024). Earlier draft used OpenAI's
// "popular sizes" of 1536x1024 / 1024x1536 for both 16:9 AND 3:2, which would
// have given users the wrong aspect ratio when they asked for widescreen.
// SIZE_TABLE indexed by `resolution` (1k/2k). 4k is rejected before lookup.
const SIZE_TABLE: Record<"1k" | "2k", Record<string, string>> = {
  "1k": {
    "1:1":  "1024x1024",  // 1.05M px
    "16:9": "1536x864",   // 1.33M px (864 = 54*16)
    "9:16": "864x1536",
    "3:2":  "1536x1024",  // 1.57M px
    "2:3":  "1024x1536",
    "4:3":  "1280x960",   // 1.23M px
    "3:4":  "960x1280",
  },
  "2k": {
    "1:1":  "2048x2048",  // 4.19M px
    "16:9": "2048x1152",  // 2.36M px (already true 16:9)
    "9:16": "1152x2048",
    "3:2":  "2304x1536",  // 3.54M px
    "2:3":  "1536x2304",
    "4:3":  "2048x1536",  // 3.15M px
    "3:4":  "1536x2048",
  },
};

const OPENAI_ALLOWED_AR = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
]);

export function mapToOpenAISize(resolution: "1k" | "2k" | "4k", ar: string | null): string {
  if (resolution === "4k") {
    throw new Error("OpenAI provider does not support resolution=4k.");
  }
  const effectiveAr = ar ?? "1:1";
  const size = SIZE_TABLE[resolution]?.[effectiveAr];
  if (!size) {
    const supported = Object.keys(SIZE_TABLE[resolution]).join(", ");
    throw new Error(`Unsupported ar "${effectiveAr}" for resolution "${resolution}". Supported: ${supported}`);
  }
  return size;
}

function openaiValidateRequest(req: GenerateRequest): void {
  if (req.resolution === "4k") {
    throw new Error("OpenAI provider does not support resolution=4k.");
  }
  if (req.ar && !OPENAI_ALLOWED_AR.has(req.ar)) {
    throw new Error(
      `OpenAI provider does not support --ar ${req.ar}. Allowed: ${[...OPENAI_ALLOWED_AR].join(", ")}`,
    );
  }
}

export function mapOpenAIBatchState(raw: string): BatchJob["state"] {
  switch (raw) {
    case "validating": return "pending";
    case "in_progress": return "running";
    case "finalizing": return "running";
    case "cancelling": return "running";
    case "completed": return "succeeded";
    case "failed": return "failed";
    case "expired": return "expired";
    case "cancelled": return "cancelled";
    default: return "pending";
  }
}

interface OpenAIErrorBody {
  code?: string;
  message?: string;
  type?: string;
}

const SAFETY_CODES = new Set(["moderation_blocked", "content_policy_violation"]);

export function mapOpenAIError(err: OpenAIErrorBody): GenerateResult {
  const reason = err.message ?? err.code ?? "Unknown OpenAI error";
  if (err.code && SAFETY_CODES.has(err.code)) {
    return {
      images: [],
      finishReason: "SAFETY",
      safetyInfo: { reason },
    };
  }
  return {
    images: [],
    finishReason: "ERROR",
    safetyInfo: { reason },
  };
}

// === Headers ===

function openaiHeaders(apiKey: string): Record<string, string> {
  return { "Authorization": `Bearer ${apiKey}` };
}

// === Payload builders ===

function inferMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

export function buildGenerationsPayload(req: GenerateRequest): Record<string, unknown> {
  return {
    model: req.model,
    prompt: req.prompt,
    n: 1,
    size: mapToOpenAISize(req.resolution, req.ar),
    quality: req.detail,
    output_format: "png",
  };
}

export function buildEditFormData(req: GenerateRequest): FormData {
  const fd = new FormData();
  fd.append("model", req.model);
  fd.append("prompt", req.prompt);
  fd.append("n", "1");
  fd.append("size", mapToOpenAISize(req.resolution, req.ar));
  fd.append("quality", req.detail);
  fd.append("output_format", "png");

  // image[] order: editTarget first (if any), then refs (incl. character refs)
  const images: string[] = [];
  if (req.editTarget) images.push(req.editTarget);
  images.push(...req.refs);
  for (const path of images) {
    const data = readFileSync(path);
    fd.append("image[]", new Blob([data], { type: inferMimeType(path) }), basename(path));
  }

  if (req.mask) {
    const maskData = readFileSync(req.mask);
    fd.append("mask", new Blob([maskData], { type: "image/png" }), "mask.png");
  }

  return fd;
}

export function parseOpenAIResponse(apiResponse: { data?: Array<{ b64_json?: string }> }): GenerateResult {
  const items = apiResponse.data ?? [];
  const images = items
    .filter((it) => it.b64_json)
    .map((it) => ({
      data: Buffer.from(it.b64_json!, "base64") as unknown as Uint8Array,
      mimeType: "image/png",
    }));
  return {
    images,
    finishReason: images.length > 0 ? "STOP" : "OTHER",
  };
}

// === Batch JSONL ===

export function buildOpenAIBatchJsonl(tasks: GenerateRequest[]): { data: Uint8Array; keys: string[] } {
  const keys: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const seq = String(i + 1).padStart(3, "0");
    const slug = generateSlug(task.prompt);
    const key = `${seq}-${slug}`;
    keys.push(key);
    lines.push(JSON.stringify({
      custom_id: key,
      method: "POST",
      url: "/v1/images/generations",
      body: buildGenerationsPayload(task),
    }));
  }
  return { data: new TextEncoder().encode(lines.join("\n") + "\n"), keys };
}

// === Provider factory ===

const RETRY_DELAYS = [1000, 2000, 4000];
const RETRYABLE_STATUS = new Set([429, 500, 503]);

function rejectImageInputsForBatch(tasks: GenerateRequest[]): void {
  const offending = tasks.filter(t => t.refs.length > 0 || t.editTarget || t.mask);
  if (offending.length > 0) {
    throw new Error(
      `OpenAI server-side batch is text-only. ${offending.length} task(s) have image inputs ` +
      `(refs / editTarget / mask). Note: --character profile injects refs into all tasks, which ` +
      `also triggers this restriction. Either remove image inputs or use realtime mode.`,
    );
  }
}

// OpenAI's edit and batch endpoints both use multipart/form-data uploads, which
// the current HTTP layer cannot route through an HTTP proxy. Surface this early
// with a clear message instead of silently failing 4 times via the retry path.
function rejectMultipartUnderProxy(operation: string): void {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    throw new Error(
      `OpenAI ${operation} uses multipart upload which is not supported through HTTP proxy ` +
      `(detected: ${proxy}). Disable the proxy environment variable for this command, ` +
      `or use --provider google for proxy-friendly workflows.`,
    );
  }
}

export function createOpenAIProvider(config: ProviderConfig): Provider {
  const { apiKey, baseUrl } = config;
  const headers = openaiHeaders(apiKey);

  function shouldRouteToEdits(req: GenerateRequest): boolean {
    return Boolean(req.editTarget) || req.refs.length > 0 || Boolean(req.mask);
  }

  async function uploadBatchFile(jsonl: Uint8Array, displayName: string): Promise<string> {
    const fd = new FormData();
    fd.append("purpose", "batch");
    fd.append("file", new Blob([jsonl], { type: "application/jsonl" }), `${displayName}.jsonl`);
    const res = await httpPostMultipartWithRetry(`${baseUrl}/v1/files`, fd, headers);
    if (res.status !== 200) {
      const err = (res.data as any)?.error;
      throw new Error(`OpenAI Files upload failed (${res.status}): ${err?.message ?? "unknown"}`);
    }
    return (res.data as { id: string }).id;
  }

  async function downloadBatchFile(fileId: string): Promise<string> {
    const res = await httpGetTextWithRetry(`${baseUrl}/v1/files/${fileId}/content`, headers);
    if (res.status !== 200) {
      throw new Error(`Failed to download file ${fileId} (${res.status}): ${res.text.slice(0, 200)}`);
    }
    return res.text;
  }

  async function generateOnce(req: GenerateRequest): Promise<GenerateResult> {
    if (shouldRouteToEdits(req)) {
      rejectMultipartUnderProxy("edit");
      const fd = buildEditFormData(req);
      const url = `${baseUrl}/v1/images/edits`;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        const res = await httpPostMultipart(url, fd, headers);
        if (res.status === 200) {
          return parseOpenAIResponse(res.data as { data?: Array<{ b64_json?: string }> });
        }
        if (res.status === 401 || res.status === 403) {
          const err = (res.data as any)?.error;
          throw new Error(`OpenAI auth failed (${res.status}): ${err?.message ?? "unknown"}`);
        }
        if (res.status === 400) {
          const err = (res.data as any)?.error;
          return mapOpenAIError(err ?? {});
        }
        if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_DELAYS.length) {
          const err = (res.data as any)?.error;
          throw new Error(err?.message ?? `OpenAI HTTP ${res.status}`);
        }
        await Bun.sleep(RETRY_DELAYS[attempt]);
      }
      throw new Error("Unreachable");
    }
    // generations
    const payload = buildGenerationsPayload(req);
    const url = `${baseUrl}/v1/images/generations`;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      const res = await httpPost(url, payload, headers);
      if (res.status === 200) {
        return parseOpenAIResponse(res.data as { data?: Array<{ b64_json?: string }> });
      }
      if (res.status === 401 || res.status === 403) {
        const err = (res.data as any)?.error;
        throw new Error(`OpenAI auth failed (${res.status}): ${err?.message ?? "unknown"}`);
      }
      if (res.status === 400) {
        const err = (res.data as any)?.error;
        return mapOpenAIError(err ?? {});
      }
      if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_DELAYS.length) {
        const err = (res.data as any)?.error;
        throw new Error(err?.message ?? `OpenAI HTTP ${res.status}`);
      }
      await Bun.sleep(RETRY_DELAYS[attempt]);
    }
    throw new Error("Unreachable");
  }

  return {
    name: "openai",
    defaultModel: "gpt-image-2",
    validateRequest: openaiValidateRequest,
    generate: generateOnce,

    async batchCreate(req: BatchCreateRequest): Promise<BatchJob> {
      rejectImageInputsForBatch(req.tasks);
      rejectMultipartUnderProxy("batch file upload");
      const displayName = req.displayName ?? `jdy-imagine-${Date.now()}`;
      const { data: jsonl } = buildOpenAIBatchJsonl(req.tasks);
      const fileId = await uploadBatchFile(jsonl, displayName);
      const res = await httpPostWithRetry(
        `${baseUrl}/v1/batches`,
        {
          input_file_id: fileId,
          endpoint: "/v1/images/generations",
          completion_window: "24h",
          metadata: { display_name: displayName },
        },
        headers,
      );
      if (res.status !== 200) {
        const err = (res.data as any)?.error;
        throw new Error(`OpenAI batch create failed (${res.status}): ${err?.message ?? "unknown"}`);
      }
      const d = res.data as { id: string; status: string; created_at?: number };
      return {
        id: d.id,
        state: mapOpenAIBatchState(d.status),
        createTime: d.created_at ? new Date(d.created_at * 1000).toISOString() : new Date().toISOString(),
      };
    },

    async batchGet(jobId: string): Promise<BatchJob> {
      const res = await httpGetWithRetry(`${baseUrl}/v1/batches/${jobId}`, headers);
      if (res.status !== 200) {
        const err = (res.data as any)?.error;
        throw new Error(err?.message ?? `OpenAI HTTP ${res.status}`);
      }
      const d = res.data as {
        id: string;
        status: string;
        created_at?: number;
        request_counts?: { total?: number; completed?: number; failed?: number };
        output_file_id?: string;
        error_file_id?: string;
      };
      return {
        id: d.id,
        state: mapOpenAIBatchState(d.status),
        createTime: d.created_at ? new Date(d.created_at * 1000).toISOString() : "",
        stats: d.request_counts && d.request_counts.total != null
          ? {
            total: d.request_counts.total,
            succeeded: d.request_counts.completed ?? 0,
            failed: d.request_counts.failed ?? 0,
          }
          : undefined,
        responsesFile: d.output_file_id ?? d.error_file_id,
      };
    },

    async batchFetch(jobId: string): Promise<BatchResult[]> {
      const metaRes = await httpGetWithRetry(`${baseUrl}/v1/batches/${jobId}`, headers);
      if (metaRes.status !== 200) {
        const err = (metaRes.data as any)?.error;
        throw new Error(err?.message ?? `OpenAI HTTP ${metaRes.status}`);
      }
      const meta = metaRes.data as {
        output_file_id?: string;
        error_file_id?: string;
        status?: string;
        request_counts?: { total?: number };
      };
      if (!meta.output_file_id && !meta.error_file_id) {
        throw new Error(`Batch job has neither output_file_id nor error_file_id (status=${meta.status})`);
      }
      const resultsByKey = new Map<string, BatchResult>();
      const parseLines = (text: string) => {
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let parsed: any;
          try { parsed = JSON.parse(line); }
          catch { continue; }
          const key = parsed.custom_id ?? "unknown";
          if (parsed.error) {
            resultsByKey.set(key, { key, error: parsed.error.message ?? "Unknown error" });
            continue;
          }
          const responseBody = parsed.response?.body;
          if (responseBody?.error) {
            resultsByKey.set(key, { key, error: responseBody.error.message ?? "Unknown error" });
            continue;
          }
          if (responseBody?.data) {
            resultsByKey.set(key, { key, result: parseOpenAIResponse(responseBody) });
            continue;
          }
          resultsByKey.set(key, { key, error: "No response in result line" });
        }
      };
      if (meta.output_file_id) {
        parseLines(await downloadBatchFile(meta.output_file_id));
      }
      if (meta.error_file_id) {
        parseLines(await downloadBatchFile(meta.error_file_id));
      }
      const expected = meta.request_counts?.total;
      if (expected != null && resultsByKey.size < expected) {
        console.error(
          `Warning: Expected ${expected} results, got ${resultsByKey.size}. ` +
          `${expected - resultsByKey.size} result(s) may be missing.`,
        );
      }
      return Array.from(resultsByKey.values());
    },

    async batchList(): Promise<BatchJob[]> {
      const res = await httpGetWithRetry(`${baseUrl}/v1/batches`, headers);
      if (res.status !== 200) {
        const err = (res.data as any)?.error;
        throw new Error(err?.message ?? `OpenAI HTTP ${res.status}`);
      }
      const d = res.data as { data?: Array<{ id: string; status: string; created_at?: number }> };
      return (d.data ?? []).map((b) => ({
        id: b.id,
        state: mapOpenAIBatchState(b.status),
        createTime: b.created_at ? new Date(b.created_at * 1000).toISOString() : "",
      }));
    },

    async batchCancel(jobId: string): Promise<void> {
      const res = await httpPostWithRetry(`${baseUrl}/v1/batches/${jobId}/cancel`, {}, headers);
      if (res.status !== 200) {
        const err = (res.data as any)?.error;
        throw new Error(err?.message ?? `OpenAI HTTP ${res.status}`);
      }
    },
  };
}
