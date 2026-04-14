export interface GenerateRequest {
  prompt: string;
  model: string;
  ar: string | null;
  quality: "normal" | "2k";
  refs: string[]; // local file paths
  imageSize: "1K" | "2K" | "4K";
}

export interface GenerateResult {
  images: Array<{
    data: Uint8Array;
    mimeType: string; // "image/png" | "image/jpeg"
  }>;
  finishReason: "STOP" | "SAFETY" | "MAX_TOKENS" | "OTHER";
  safetyInfo?: {
    category: string;
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
  id: string; // e.g. "batches/abc123"
  state:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "expired";
  createTime: string;
  stats?: { total: number; succeeded: number; failed: number };
}

export interface BatchResult {
  key: string;
  result?: GenerateResult; // same structure as realtime
  error?: string;
}

export type ChainAnchor = unknown;

export interface Provider {
  name: string;
  defaultModel: string;

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
