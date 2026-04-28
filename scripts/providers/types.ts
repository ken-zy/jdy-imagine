export interface GenerateRequest {
  prompt: string;
  model: string;
  ar: string | null;
  /** @deprecated kept until Task 1.7 cleanup; new code reads `resolution` */
  quality: "normal" | "2k";
  /** @deprecated kept until Task 1.7 cleanup; google derives uppercase from `resolution` */
  imageSize: "1K" | "2K" | "4K";
  /** Resolution tier — replaces `quality` for the dimension dimension. */
  resolution: "1k" | "2k" | "4k";
  /** Detail tier — replaces the OpenAI-specific quality/sharpness mapping. */
  detail: "auto" | "low" | "medium" | "high";
  refs: string[];                 // 参考图（风格/构图样板）
  editTarget?: string;            // OpenAI: route to /v1/images/edits; Google: fallback to refs[0]
  mask?: string;                  // OpenAI edit only; Google: provider throws
}

export interface GenerateResult {
  images: Array<{
    data: Uint8Array;
    mimeType: string; // "image/png" | "image/jpeg"
  }>;
  finishReason: "STOP" | "SAFETY" | "ERROR" | "OTHER";
  safetyInfo?: {
    category?: string;            // Optional: Gemini fills, OpenAI does not
    reason: string;
  };
  textParts?: string[]; // any text returned alongside images
}

export interface BatchCreateRequest {
  model: string;
  tasks: GenerateRequest[];
  displayName?: string;
}

export interface BatchJob {
  id: string; // e.g. "batches/abc123" (Google) or "batch_xxx" (OpenAI)
  state:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "expired";
  createTime: string;
  stats?: { total: number; succeeded: number; failed: number };
  responsesFile?: string; // file-based output: "files/abc123" or OpenAI file id
}

export interface BatchResult {
  key: string;
  result?: GenerateResult; // same structure as realtime
  error?: string;
}

export type ChainAnchor = unknown;

// Provider configuration object passed to factory.
// Future providers can extend this with region/orgId/projectId without breaking
// the factory signature.
export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type ProviderFactory = (config: ProviderConfig) => Provider;

export interface Provider {
  name: string;
  defaultModel: string;

  /** Optional fail-fast hook called by command layer for every final GenerateRequest before any
   * provider.generate / batchCreate runs. Provider throws if the request violates its capabilities
   * (e.g. apimart 4K requires specific ar; google does not support 4K). Skipping this hook is OK;
   * generate() still does its own runtime validation. */
  validateRequest?(req: GenerateRequest): void;

  // Realtime
  generate(req: GenerateRequest): Promise<GenerateResult>;

  // Chain (optional – character-consistency)
  generateAndAnchor?(req: GenerateRequest): Promise<{ result: GenerateResult; anchor: ChainAnchor }>;
  generateChained?(req: GenerateRequest, anchor: ChainAnchor): Promise<GenerateResult>;

  // Batch (optional)
  batchCreate?(req: BatchCreateRequest): Promise<BatchJob>;
  batchGet?(jobId: string): Promise<BatchJob>;
  batchFetch?(jobId: string): Promise<BatchResult[]>;
  batchList?(): Promise<BatchJob[]>;
  batchCancel?(jobId: string): Promise<void>;
}

// Provider-agnostic enum mapping. Located in types.ts so consumers don't depend
// on a specific provider implementation file.
export function mapQualityToImageSize(
  quality: "normal" | "2k",
): "1K" | "2K" {
  return quality === "normal" ? "1K" : "2K";
}
