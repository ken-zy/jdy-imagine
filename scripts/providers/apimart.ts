import { basename } from "path";
import { detectProxy, httpGet, httpGetBytes, httpPost, httpPostMultipart } from "../lib/http";
import type {
  GenerateRequest,
  GenerateResult,
  Provider,
  ProviderConfig,
} from "./types";

const APIMART_ALLOWED_AR = new Set([
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "5:4", "4:5", "2:1", "1:2", "21:9", "9:21",
]);
const APIMART_4K_ALLOWED_AR = new Set([
  "16:9", "9:16", "2:1", "1:2", "21:9", "9:21",
]);

const DEFAULT_POLL_INITIAL_WAIT_MS = 12_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_TIMEOUT_MS = 180_000;
const RETRY_DELAYS = [1_000, 2_000, 4_000];
// Spec lists {429,500,502,503}; we also retry on status=0 because httpGetBytes
// surfaces network failures as 0 (rather than the 503 sentinel httpPost/httpGet use).
const RETRYABLE_STATUS = new Set([0, 429, 500, 502, 503]);
const SAFETY_KEYWORDS = ["moderation", "policy", "unsafe", "safety", "block"];

export interface ApimartProviderOpts {
  pollInitialMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type NormalizedStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

function normalizeApimartStatus(raw: string): NormalizedStatus {
  switch (raw) {
    case "submitted":
    case "pending":     return "pending";
    case "in_progress":
    case "processing":  return "running";
    case "completed":   return "completed";
    case "failed":      return "failed";
    case "cancelled":   return "cancelled";
    default:            return "pending"; // unknown → keep polling defensively
  }
}

function extractFailReason(data: any): string {
  if (data?.error?.message) {
    const t = data.error.type ? `[${data.error.type}] ` : "";
    return `${t}${data.error.message}`;
  }
  return data?.fail_reason ?? "unknown";
}

// HTTP error responses for upload/submit/poll/download may have nested
// `{error: {message, code, type}}` (apimart docs) or top-level `{message: ...}`.
// Read both so safety detection / error reporting doesn't fall back to a generic.
function extractHttpErrorMessage(res: { data?: any; error?: any }): string {
  const d = res.data;
  if (d?.error?.message) {
    const t = d.error.type ? `[${d.error.type}] ` : "";
    return `${t}${d.error.message}`;
  }
  if (typeof d?.message === "string") return d.message;
  if (typeof res.error === "string") return res.error;
  return "unknown error";
}

function isSafetyFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return SAFETY_KEYWORDS.some(k => lower.includes(k));
}

function apimartHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

function validateApimartRequest(req: GenerateRequest): void {
  if (req.ar && !APIMART_ALLOWED_AR.has(req.ar)) {
    throw new Error(`apimart provider does not support --ar ${req.ar}.`);
  }
  if (req.resolution === "4k" && req.ar && !APIMART_4K_ALLOWED_AR.has(req.ar)) {
    throw new Error(
      `apimart resolution=4k requires --ar one of: ${[...APIMART_4K_ALLOWED_AR].join(", ")}; got ${req.ar}.`,
    );
  }
}

interface CallResult {
  status: number;
  data?: any;
  error?: any;
  bytes?: Uint8Array;
}

interface RetryOpts {
  allow400Result?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

async function callWithApimartRetry(
  doCall: () => Promise<CallResult>,
  context: "upload" | "submit" | "poll" | "download",
  opts: RetryOpts = {},
): Promise<CallResult> {
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const res = await doCall();
    if (res.status >= 200 && res.status < 300) return res;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `apimart ${context} auth failed (HTTP ${res.status}): ${extractHttpErrorMessage(res)}`,
      );
    }
    if (res.status === 402) {
      throw new Error("apimart insufficient balance");
    }
    if (context === "upload" && (res.status === 413 || res.status === 415)) {
      throw new Error(
        `apimart upload rejected (HTTP ${res.status}): file size > 20MB or unsupported type`,
      );
    }
    if (res.status === 400) {
      if (opts.allow400Result) return res;
      throw new Error(
        `apimart ${context} bad request (HTTP 400): ${extractHttpErrorMessage(res)}`,
      );
    }
    if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_DELAYS.length) {
      throw new Error(
        `apimart ${context} failed (HTTP ${res.status}): ${extractHttpErrorMessage(res)}`,
      );
    }
    await sleep(RETRY_DELAYS[attempt]);
  }
  throw new Error("Unreachable");
}

function buildApimartPayload(
  req: GenerateRequest,
  imageUrls?: string[],
  maskUrl?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    size: req.ar ?? "1:1",
    resolution: req.resolution,
    quality: req.detail,
    n: 1,
    output_format: "png",
    moderation: "auto",
  };
  if (imageUrls && imageUrls.length > 0) payload.image_urls = imageUrls;
  if (maskUrl) payload.mask_url = maskUrl;
  return payload;
}

type UploadCache = Map<string, Promise<string>>;

async function fileSha256(localPath: string): Promise<string> {
  const data = await Bun.file(localPath).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(data));
  return hasher.digest("hex");
}

function inferMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

function rejectMultipartUnderProxy(operation: string): void {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    throw new Error(
      `apimart ${operation} uses multipart upload which is not supported through HTTP proxy ` +
        `(detected: ${proxy}). Disable the proxy environment variable for this command, ` +
        `or use --provider openai/google for proxy-friendly workflows.`,
    );
  }
}

async function doUpload(
  baseUrl: string,
  headers: Record<string, string>,
  localPath: string,
  retryOpts: { sleep: (ms: number) => Promise<void> },
): Promise<string> {
  const buf = await Bun.file(localPath).arrayBuffer();
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([buf], { type: inferMimeType(localPath) }),
    basename(localPath),
  );
  const url = `${baseUrl}/v1/uploads/images`;
  const res = await callWithApimartRetry(
    () => httpPostMultipart(url, fd, headers),
    "upload",
    retryOpts,
  );
  const uploadUrl = (res.data as any)?.url;
  if (typeof uploadUrl !== "string") {
    throw new Error(`apimart upload response missing url: ${JSON.stringify(res.data)}`);
  }
  return uploadUrl;
}

async function uploadToApimartCached(
  baseUrl: string,
  headers: Record<string, string>,
  localPath: string,
  cache: UploadCache,
  retryOpts: { sleep: (ms: number) => Promise<void> },
): Promise<string> {
  const hash = await fileSha256(localPath);
  const cached = cache.get(hash);
  if (cached) return await cached;
  // CRITICAL: cache.set BEFORE await so concurrent same-hash calls hit the in-flight Promise.
  // catch+delete on rejection so future generate() calls can re-attempt without poisoning.
  const promise = doUpload(baseUrl, headers, localPath, retryOpts).catch((err) => {
    cache.delete(hash);
    throw err;
  });
  cache.set(hash, promise);
  return await promise;
}

interface ResolvedPollOpts {
  initialMs: number;
  intervalMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

async function pollTask(
  baseUrl: string,
  apiKey: string,
  taskId: string,
  opts: ResolvedPollOpts,
  retryOpts: { sleep: (ms: number) => Promise<void> },
): Promise<{ result: GenerateResult } | { error: string; isSafety: boolean }> {
  const headers = apimartHeaders(apiKey);
  const url = `${baseUrl}/v1/tasks/${taskId}`;
  await opts.sleep(opts.initialMs);
  const start = opts.now();
  while (true) {
    const res = await callWithApimartRetry(() => httpGet(url, headers), "poll", retryOpts);
    const data = (res.data as any)?.data;
    const status = normalizeApimartStatus(data?.status ?? "pending");
    if (status === "completed") {
      const images = data?.result?.images ?? [];
      const bytes = await Promise.all(
        images.map(async (img: any) => {
          const downloadUrl = Array.isArray(img.url) ? img.url[0] : img.url;
          const dl = await callWithApimartRetry(
            () => httpGetBytes(downloadUrl),
            "download",
            retryOpts,
          );
          return { data: dl.bytes!, mimeType: "image/png" };
        }),
      );
      return { result: { images: bytes, finishReason: "STOP" } };
    }
    if (status === "failed") {
      const reason = extractFailReason(data);
      return { error: reason, isSafety: isSafetyFailure(reason) };
    }
    if (status === "cancelled") {
      return { error: "task cancelled", isSafety: false };
    }
    if (opts.now() - start >= opts.timeoutMs) {
      throw new Error(
        `apimart task polling timeout (>${opts.timeoutMs / 1000}s); task_id=${taskId} ` +
          `(check apimart console; result may still complete and be retrievable manually)`,
      );
    }
    await opts.sleep(opts.intervalMs);
  }
}

export function createApimartProvider(
  config: ProviderConfig,
  opts: ApimartProviderOpts = {},
): Provider {
  const { apiKey, baseUrl } = config;
  const headers = apimartHeaders(apiKey);
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pollOpts: ResolvedPollOpts = {
    initialMs: opts.pollInitialMs ?? DEFAULT_POLL_INITIAL_WAIT_MS,
    intervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    sleep,
    now: opts.now ?? (() => Date.now()),
  };
  const retryOpts = { sleep };
  const uploadCache: UploadCache = new Map();

  async function generate(req: GenerateRequest): Promise<GenerateResult> {
    let imageUrls: string[] | undefined;
    let maskUrl: string | undefined;

    if (req.refs.length > 0 || req.editTarget || req.mask) {
      // Pre-emptive proxy guard: multipart uploads can't route through HTTPS_PROXY
      // (Bun's fetch with FormData isn't proxy-aware), so we'd silently fail downstream.
      rejectMultipartUnderProxy("upload");

      // Track upload role per index so we can split image_urls vs mask_url after the
      // Promise.all dispatch (which preserves submission order).
      const uploads: Array<{ path: string; role: "image" | "mask" }> = [];
      if (req.editTarget) uploads.push({ path: req.editTarget, role: "image" });
      for (const ref of req.refs) uploads.push({ path: ref, role: "image" });
      if (req.mask) uploads.push({ path: req.mask, role: "mask" });

      const urls = await Promise.all(
        uploads.map(u => uploadToApimartCached(baseUrl, headers, u.path, uploadCache, retryOpts)),
      );

      imageUrls = uploads
        .map((u, i) => (u.role === "image" ? urls[i] : null))
        .filter((u): u is string => u !== null);
      const maskIdx = uploads.findIndex(u => u.role === "mask");
      maskUrl = maskIdx >= 0 ? urls[maskIdx] : undefined;
    }

    const payload = buildApimartPayload(req, imageUrls, maskUrl);
    const submitUrl = `${baseUrl}/v1/images/generations`;
    const submitRes = await callWithApimartRetry(
      () => httpPost(submitUrl, payload, headers),
      "submit",
      { allow400Result: true, sleep },
    );

    if (submitRes.status === 400) {
      const reason = extractHttpErrorMessage(submitRes);
      return {
        images: [],
        finishReason: isSafetyFailure(reason) ? "SAFETY" : "ERROR",
        safetyInfo: { reason },
      };
    }

    const taskId = (submitRes.data as any)?.data?.[0]?.task_id;
    if (!taskId) throw new Error("apimart submit response missing task_id");

    const polled = await pollTask(baseUrl, apiKey, taskId, pollOpts, retryOpts);
    if ("error" in polled) {
      return {
        images: [],
        finishReason: polled.isSafety ? "SAFETY" : "ERROR",
        safetyInfo: { reason: polled.error },
      };
    }
    return polled.result;
  }

  return {
    name: "apimart",
    defaultModel: "gpt-image-2-official",
    validateRequest: validateApimartRequest,
    generate,
  };
}
