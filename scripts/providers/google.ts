import { readFileSync } from "fs";
import { httpPost, httpGet, httpPostWithRetry, httpGetWithRetry } from "../lib/http";
import { uploadJsonl, downloadJsonl } from "../lib/files";
import { generateSlug } from "../lib/output";
import type {
  GenerateRequest,
  GenerateResult,
  BatchCreateRequest,
  BatchJob,
  BatchResult,
  Provider,
  ProviderConfig,
  ChainAnchor,
} from "./types";

// Re-export for backward compatibility — the canonical location is types.ts.
// generate.ts and batch.ts can import from either path; existing tests that
// import from "./google" continue to work.
export { mapQualityToImageSize } from "./types";

export function buildRealtimeRequestBody(req: GenerateRequest): {
  contents: Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
  generationConfig: {
    responseModalities: string[];
    imageConfig: { imageSize: string };
  };
} {
  const parts: Array<Record<string, unknown>> = [];

  // Add ref images as inlineData parts
  for (const refPath of req.refs) {
    const data = readFileSync(refPath);
    const ext = refPath.split(".").pop()?.toLowerCase();
    const mimeType =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
    parts.push({
      inlineData: {
        data: Buffer.from(data).toString("base64"),
        mimeType,
      },
    });
  }

  // Build prompt text with aspect ratio appended
  let promptText = req.prompt;
  if (req.ar) {
    promptText += `. Aspect ratio: ${req.ar}.`;
  }
  parts.push({ text: promptText });

  return {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { imageSize: req.imageSize },
    },
  };
}

export function parseGenerateResponse(apiResponse: {
  candidates?: Array<{
    content?: { parts?: Array<Record<string, unknown>> };
    finishReason?: string;
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  }>;
}): GenerateResult {
  const candidate = apiResponse.candidates?.[0];
  const rawReason = candidate?.finishReason ?? "OTHER";
  // Map Gemini's MAX_TOKENS to OTHER (image generation has no token-based stop)
  const finishReason: GenerateResult["finishReason"] =
    rawReason === "STOP" || rawReason === "SAFETY" ? rawReason : "OTHER";

  const result: GenerateResult = {
    images: [],
    finishReason,
  };

  // Handle safety block
  if (finishReason === "SAFETY") {
    const rating = candidate?.safetyRatings?.[0];
    if (rating) {
      result.safetyInfo = {
        category: rating.category,
        reason: `Blocked: ${rating.category} (${rating.probability})`,
      };
    }
    return result;
  }

  // Parse parts
  const parts = candidate?.content?.parts ?? [];
  const textParts: string[] = [];

  for (const part of parts) {
    if (part.inlineData) {
      const inline = part.inlineData as {
        data: string;
        mimeType: string;
      };
      result.images.push({
        data: Buffer.from(inline.data, "base64"),
        mimeType: inline.mimeType,
      });
    } else if (typeof part.text === "string") {
      textParts.push(part.text);
    }
  }

  if (textParts.length > 0) {
    result.textParts = textParts;
  }

  return result;
}

// Google-internal chain anchor type
interface GoogleChainAnchor {
  firstUserParts: Array<Record<string, unknown>>;
  modelContent: { role: string; parts: Array<Record<string, unknown>> };
}

export function createGoogleAnchor(
  firstReq: GenerateRequest,
  rawResponse: unknown,
): GoogleChainAnchor | null {
  const resp = rawResponse as {
    candidates?: Array<{
      content?: { role: string; parts: Array<Record<string, unknown>> };
    }>;
  };
  const modelContent = resp.candidates?.[0]?.content;
  if (!modelContent) {
    // SAFETY blocks often return no content — let orchestrator handle via first-image guard
    return null;
  }

  const body = buildRealtimeRequestBody(firstReq);
  const firstUserParts = body.contents[0].parts;

  return { firstUserParts, modelContent };
}

export function buildChainedRequestBody(
  req: GenerateRequest,
  anchor: GoogleChainAnchor,
): {
  contents: Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
  generationConfig: {
    responseModalities: string[];
    imageConfig: { imageSize: string };
  };
} {
  // Current user turn: task-specific refs (NOT character refs) + prompt
  const currentParts: Array<Record<string, unknown>> = [];
  for (const refPath of req.refs) {
    const data = readFileSync(refPath);
    const ext = refPath.split(".").pop()?.toLowerCase();
    const mimeType =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
    currentParts.push({
      inlineData: {
        data: Buffer.from(data).toString("base64"),
        mimeType,
      },
    });
  }
  let promptText = req.prompt;
  if (req.ar) {
    promptText += `. Aspect ratio: ${req.ar}.`;
  }
  currentParts.push({ text: promptText });

  return {
    contents: [
      { role: "user", parts: anchor.firstUserParts },
      { role: anchor.modelContent.role, parts: anchor.modelContent.parts },
      { role: "user", parts: currentParts },
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { imageSize: req.imageSize },
    },
  };
}

export function validateBatchTasks(_tasks: GenerateRequest[]): void {
  // Batch mode supports reference images via inline base64 (same as realtime)
}

export function buildBatchRequestBody(
  model: string,
  tasks: GenerateRequest[],
  displayName: string,
): {
  batch: {
    display_name: string;
    input_config: {
      requests: {
        requests: Array<{
          request: {
            contents: Array<{ parts: Array<Record<string, unknown>> }>;
            generationConfig: {
              responseModalities: string[];
              imageConfig: { imageSize: string };
            };
          };
          metadata: { key: string };
        }>;
      };
    };
  };
} {
  const requests = tasks.map((task, i) => {
    const seq = String(i + 1).padStart(3, "0");
    const slug = generateSlug(task.prompt);

    // Build parts: ref images first (as inlineData), then prompt text
    const parts: Array<Record<string, unknown>> = [];
    for (const refPath of task.refs) {
      const data = readFileSync(refPath);
      const ext = refPath.split(".").pop()?.toLowerCase();
      const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
      parts.push({
        inlineData: {
          data: Buffer.from(data).toString("base64"),
          mimeType,
        },
      });
    }

    let promptText = task.prompt;
    if (task.ar) {
      promptText += `. Aspect ratio: ${task.ar}.`;
    }
    parts.push({ text: promptText });

    return {
      request: {
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { imageSize: task.imageSize },
        },
      },
      metadata: { key: `${seq}-${slug}` },
    };
  });

  return {
    batch: {
      display_name: displayName,
      input_config: {
        requests: { requests },
      },
    },
  };
}

export function buildBatchJsonl(
  _model: string,
  tasks: GenerateRequest[],
  _displayName: string,
): { data: Uint8Array; keys: string[] } {
  const keys: string[] = [];
  const lines: string[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const seq = String(i + 1).padStart(3, "0");
    const slug = generateSlug(task.prompt);
    const key = `${seq}-${slug}`;
    keys.push(key);

    const parts: Array<Record<string, unknown>> = [];
    for (const refPath of task.refs) {
      const data = readFileSync(refPath);
      const ext = refPath.split(".").pop()?.toLowerCase();
      const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
      parts.push({
        inlineData: {
          data: Buffer.from(data).toString("base64"),
          mimeType,
        },
      });
    }

    let promptText = task.prompt;
    if (task.ar) {
      promptText += `. Aspect ratio: ${task.ar}.`;
    }
    parts.push({ text: promptText });

    const lineObj = {
      key,
      request: {
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { imageSize: task.imageSize },
        },
      },
    };
    lines.push(JSON.stringify(lineObj));
  }

  const text = lines.join("\n") + "\n";
  return { data: new TextEncoder().encode(text), keys };
}

export function parseBatchResponse(apiResponse: {
  inlinedResponses?: Array<{
    metadata?: { key?: string };
    response?: {
      candidates?: Array<{
        content?: { parts?: Array<Record<string, unknown>> };
        finishReason?: string;
        safetyRatings?: Array<{ category: string; probability: string }>;
      }>;
      error?: { message?: string };
    };
  }>;
}): BatchResult[] {
  const responses = apiResponse.inlinedResponses ?? [];
  return responses.map((entry) => {
    const key = entry.metadata?.key ?? "unknown";

    if (entry.response?.error) {
      return { key, error: entry.response.error.message ?? "Unknown error" };
    }

    const result = parseGenerateResponse(
      entry.response as Parameters<typeof parseGenerateResponse>[0],
    );
    return { key, result };
  });
}

export function parseJsonlResultLine(line: string): BatchResult | null {
  if (!line.trim()) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.error(`Warning: Failed to parse JSONL line: ${line.slice(0, 100)}`);
    return null;
  }

  const key = (parsed.key as string) ?? "unknown";

  // Top-level error
  if (parsed.error) {
    const errObj = parsed.error as { message?: string };
    return { key, error: errObj.message ?? "Unknown error" };
  }

  // Response with error
  const response = parsed.response as Record<string, unknown> | undefined;
  if (response?.error) {
    const errObj = response.error as { message?: string };
    return { key, error: errObj.message ?? "Unknown error" };
  }

  // Successful response
  if (response) {
    const result = parseGenerateResponse(
      response as Parameters<typeof parseGenerateResponse>[0],
    );
    return { key, result };
  }

  return { key, error: "No response in result line" };
}

const RETRY_DELAYS = [1000, 2000, 4000];
const RETRYABLE_STATUS = new Set([429, 500, 503]);

function googleHeaders(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey };
}

// Google has no /edits endpoint — editTarget falls back to refs[0].
function applyEditTargetFallback(req: GenerateRequest): GenerateRequest {
  if (!req.editTarget) return req;
  return { ...req, refs: [req.editTarget, ...req.refs] };
}

// Google's image generation has no equivalent to OpenAI's mask. Rather than
// silently drop, throw so the user knows their request can't be satisfied.
function rejectMask(req: GenerateRequest): void {
  if (req.mask) {
    throw new Error("Google provider does not support --mask. Mask is OpenAI-only.");
  }
}

export function createGoogleProvider(config: ProviderConfig): Provider;
// Legacy two-arg signature kept for callers/tests that haven't migrated yet.
export function createGoogleProvider(apiKey: string, baseUrl: string): Provider;
export function createGoogleProvider(
  configOrApiKey: ProviderConfig | string,
  legacyBaseUrl?: string,
): Provider {
  const apiKey = typeof configOrApiKey === "string" ? configOrApiKey : configOrApiKey.apiKey;
  const baseUrl = typeof configOrApiKey === "string" ? legacyBaseUrl! : configOrApiKey.baseUrl;
  const headers = googleHeaders(apiKey);
  async function generateCore(
    rawReq: GenerateRequest,
  ): Promise<{ result: GenerateResult; rawResponse: unknown }> {
    rejectMask(rawReq);
    const req = applyEditTargetFallback(rawReq);
    const url = `${baseUrl}/v1beta/models/${req.model}:generateContent`;
    const body = buildRealtimeRequestBody(req);

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      const res = await httpPost(url, body, headers);

      if (res.status === 200) {
        return {
          result: parseGenerateResponse(res.data as Parameters<typeof parseGenerateResponse>[0]),
          rawResponse: res.data,
        };
      }

      if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_DELAYS.length) {
        const errData = res.data as { error?: { message?: string } };
        const msg = errData?.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }

      await Bun.sleep(RETRY_DELAYS[attempt]);
    }

    throw new Error("Unreachable");
  }

  async function generateWithRetry(
    req: GenerateRequest,
  ): Promise<GenerateResult> {
    const { result } = await generateCore(req);
    return result;
  }

  return {
    name: "google",
    defaultModel: "gemini-3.1-flash-image-preview",
    generate: generateWithRetry,

    // Chain: first task — generate + create anchor in one call
    async generateAndAnchor(req: GenerateRequest) {
      const { result, rawResponse } = await generateCore(req);
      const anchor = createGoogleAnchor(req, rawResponse) as ChainAnchor;
      return { result, anchor };
    },

    // Chain: subsequent tasks — generate using anchor
    async generateChained(rawReq: GenerateRequest, anchor: ChainAnchor) {
      rejectMask(rawReq);
      const req = applyEditTargetFallback(rawReq);
      const googleAnchor = anchor as GoogleChainAnchor;
      const url = `${baseUrl}/v1beta/models/${req.model}:generateContent`;
      const body = buildChainedRequestBody(req, googleAnchor);

      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        const res = await httpPost(url, body, headers);
        if (res.status === 200) {
          return parseGenerateResponse(res.data as Parameters<typeof parseGenerateResponse>[0]);
        }
        if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_DELAYS.length) {
          const errData = res.data as { error?: { message?: string } };
          throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
        }
        await Bun.sleep(RETRY_DELAYS[attempt]);
      }
      throw new Error("Unreachable");
    },

    async batchCreate(req: BatchCreateRequest): Promise<BatchJob> {
      // Per-task: reject mask, apply editTarget fallback to refs[0]
      for (const t of req.tasks) rejectMask(t);
      const effectiveTasks = req.tasks.map(applyEditTargetFallback);
      validateBatchTasks(effectiveTasks);

      const displayName = req.displayName ?? `jdy-imagine-${Date.now()}`;
      const { data } = buildBatchJsonl(req.model, effectiveTasks, displayName);

      // Soft warning for large payloads (file input supports up to 2GB)
      const payloadMB = data.byteLength / (1024 * 1024);
      if (payloadMB > 50) {
        console.error(`Warning: Large payload (~${Math.round(payloadMB)}MB), upload may take a while.`);
      }

      // Upload JSONL via Files API
      const fileName = await uploadJsonl(data, displayName, apiKey, baseUrl);

      // Create batch with file reference
      const url = `${baseUrl}/v1beta/models/${req.model}:batchGenerateContent`;
      const body = {
        batch: {
          display_name: displayName,
          input_config: { file_name: fileName },
        },
      };
      const res = await httpPostWithRetry(url, body, headers);

      if (res.status !== 200) {
        const errData = res.data as { error?: { message?: string } };
        throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
      }

      const respData = res.data as {
        name?: string;
        metadata?: { state?: string; createTime?: string };
      };
      return {
        id: respData.name ?? "",
        state: (respData.metadata?.state?.toLowerCase().replace(/^(job_state_|batch_state_)/, "") ?? "pending") as BatchJob["state"],
        createTime: respData.metadata?.createTime ?? new Date().toISOString(),
      };
    },

    async batchGet(jobId: string): Promise<BatchJob> {
      const url = `${baseUrl}/v1beta/${jobId}`;
      const res = await httpGetWithRetry(url, headers);

      if (res.status !== 200) {
        const errData = res.data as { error?: { message?: string } };
        throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
      }

      const data = res.data as {
        name?: string;
        metadata?: {
          state?: string;
          createTime?: string;
          totalCount?: number;
          succeededCount?: number;
          failedCount?: number;
        };
        response?: {
          responsesFile?: string;
          inlinedResponses?: unknown[];
        };
      };
      return {
        id: data.name ?? jobId,
        state: (data.metadata?.state?.toLowerCase().replace(/^(job_state_|batch_state_)/, "") ?? "pending") as BatchJob["state"],
        createTime: data.metadata?.createTime ?? "",
        stats: data.metadata?.totalCount != null
          ? {
              total: data.metadata.totalCount,
              succeeded: data.metadata.succeededCount ?? 0,
              failed: data.metadata.failedCount ?? 0,
            }
          : undefined,
        responsesFile: data.response?.responsesFile,
      };
    },

    async batchFetch(jobId: string): Promise<BatchResult[]> {
      // Step 1: get full batch job response
      const url = `${baseUrl}/v1beta/${jobId}`;
      const res = await httpGetWithRetry(url, headers);

      if (res.status !== 200) {
        const errData = res.data as { error?: { message?: string } };
        throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
      }

      const data = res.data as {
        metadata?: { totalCount?: number; state?: string };
        response?: {
          responsesFile?: string;
          inlinedResponses?: Array<{
            metadata?: { key?: string };
            response?: Record<string, unknown>;
          }>;
        };
      };

      const expectedTotal = data.metadata?.totalCount;

      // Step 2: file-based path
      if (data.response?.responsesFile) {
        const results: BatchResult[] = [];
        await downloadJsonl(data.response.responsesFile, apiKey, baseUrl, (line) => {
          const result = parseJsonlResultLine(line);
          if (result) results.push(result);
        });

        // Completeness check
        if (expectedTotal != null && results.length < expectedTotal) {
          console.error(
            `Warning: Expected ${expectedTotal} results, got ${results.length}. ${expectedTotal - results.length} results may be missing.`,
          );
        }

        return results;
      }

      // Step 2b: inline fallback for old jobs
      if (data.response?.inlinedResponses) {
        return parseBatchResponse(data.response as Parameters<typeof parseBatchResponse>[0]);
      }

      const state = data.metadata?.state ?? "unknown";
      throw new Error(`Batch job has no result file. Job state: ${state}`);
    },

    async batchList(): Promise<BatchJob[]> {
      const url = `${baseUrl}/v1beta/batches`;
      const res = await httpGetWithRetry(url, headers);

      if (res.status !== 200) {
        const errData = res.data as { error?: { message?: string } };
        throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
      }

      const data = res.data as {
        batches?: Array<{
          name?: string;
          metadata?: { state?: string; createTime?: string };
        }>;
      };
      return (data.batches ?? []).map((b) => ({
        id: b.name ?? "",
        state: (b.metadata?.state?.toLowerCase().replace(/^(job_state_|batch_state_)/, "") ?? "pending") as BatchJob["state"],
        createTime: b.metadata?.createTime ?? "",
      }));
    },

    async batchCancel(jobId: string): Promise<void> {
      const url = `${baseUrl}/v1beta/${jobId}:cancel`;
      const res = await httpPostWithRetry(url, {}, headers);

      if (res.status !== 200) {
        const errData = res.data as { error?: { message?: string } };
        throw new Error(errData?.error?.message ?? `HTTP ${res.status}`);
      }
    },
  };
}
