import { describe, test, expect } from "bun:test";
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

describe("ProviderConfig type", () => {
  test("requires apiKey, baseUrl, model", () => {
    const cfg: ProviderConfig = { apiKey: "k", baseUrl: "https://x", model: "m" };
    expect(cfg.apiKey).toBe("k");
  });
});

describe("GenerateRequest mask/editTarget", () => {
  test("accepts optional mask and editTarget", () => {
    const req: GenerateRequest = {
      prompt: "x",
      model: "m",
      ar: null,
      resolution: "1k",
      detail: "medium",
      refs: [],
      mask: "/tmp/m.png",
      editTarget: "/tmp/e.png",
    };
    expect(req.mask).toBe("/tmp/m.png");
    expect(req.editTarget).toBe("/tmp/e.png");
  });
});

describe("GenerateResult.finishReason ERROR", () => {
  test("accepts ERROR", () => {
    const r: GenerateResult = { images: [], finishReason: "ERROR" };
    expect(r.finishReason).toBe("ERROR");
  });

  test("safetyInfo.category is optional (OpenAI omits it)", () => {
    const r: GenerateResult = {
      images: [],
      finishReason: "SAFETY",
      safetyInfo: { reason: "moderation_blocked" },
    };
    expect(r.safetyInfo?.category).toBeUndefined();
  });
});

describe("Provider types", () => {
  test("GenerateRequest has required fields", () => {
    const req: GenerateRequest = {
      prompt: "A cat",
      model: "gemini-3.1-flash-image-preview",
      ar: "16:9",
      resolution: "2k",
      detail: "high",
      refs: [],
    };
    expect(req.prompt).toBe("A cat");
    expect(req.refs).toEqual([]);
  });

  test("GenerateResult supports multi-image and safety", () => {
    const result: GenerateResult = {
      images: [
        { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
      ],
      finishReason: "STOP",
    };
    expect(result.images).toHaveLength(1);
    expect(result.finishReason).toBe("STOP");

    const blocked: GenerateResult = {
      images: [],
      finishReason: "SAFETY",
      safetyInfo: { category: "HARM_CATEGORY_DANGEROUS", reason: "Content blocked" },
    };
    expect(blocked.images).toHaveLength(0);
    expect(blocked.safetyInfo?.category).toBe("HARM_CATEGORY_DANGEROUS");
  });

  test("BatchResult references GenerateResult", () => {
    const br: BatchResult = {
      key: "001-cat",
      result: {
        images: [{ data: new Uint8Array([1]), mimeType: "image/png" }],
        finishReason: "STOP",
      },
    };
    expect(br.result?.images).toHaveLength(1);

    const errBr: BatchResult = {
      key: "002-fail",
      error: "Content blocked",
    };
    expect(errBr.error).toBe("Content blocked");
  });

  test("BatchJob has state enum", () => {
    const job: BatchJob = {
      id: "batches/abc123",
      state: "succeeded",
      createTime: "2026-04-13T10:00:00Z",
      stats: { total: 2, succeeded: 2, failed: 0 },
    };
    expect(job.state).toBe("succeeded");
  });

  test("ChainAnchor is opaque and accepts any value", () => {
    const str: ChainAnchor = "session-abc";
    const num: ChainAnchor = 42;
    const obj: ChainAnchor = { token: "xyz", seed: 123 };
    const nil: ChainAnchor = null;
    expect(str).toBe("session-abc");
    expect(num).toBe(42);
    expect(obj).toEqual({ token: "xyz", seed: 123 });
    expect(nil).toBeNull();
  });

  test("generateAndAnchor and generateChained are optional on Provider", () => {
    const minimal: Provider = {
      name: "test",
      defaultModel: "test-model",
      generate: async (_req: GenerateRequest) => ({
        images: [],
        finishReason: "STOP",
      }),
    };
    expect(minimal.generateAndAnchor).toBeUndefined();
    expect(minimal.generateChained).toBeUndefined();
  });
});

describe("BatchJob type", () => {
  test("accepts responsesFile field", () => {
    const job: BatchJob = {
      id: "batches/abc",
      state: "succeeded",
      createTime: "2026-04-14T00:00:00Z",
      responsesFile: "files/output456",
    };
    expect(job.responsesFile).toBe("files/output456");
  });

  test("responsesFile is optional", () => {
    const job: BatchJob = {
      id: "batches/abc",
      state: "pending",
      createTime: "2026-04-14T00:00:00Z",
    };
    expect(job.responsesFile).toBeUndefined();
  });
});

describe("GenerateRequest resolution/detail enums", () => {
  test("resolution accepts 1k/2k/4k", () => {
    const reqs: GenerateRequest[] = (["1k", "2k", "4k"] as const).map((r) => ({
      prompt: "x",
      model: "m",
      ar: null,
      resolution: r,
      detail: "auto",
      refs: [],
    }));
    expect(reqs.map((r) => r.resolution)).toEqual(["1k", "2k", "4k"]);
  });

  test("detail accepts auto/low/medium/high", () => {
    const reqs: GenerateRequest[] = (["auto", "low", "medium", "high"] as const).map((d) => ({
      prompt: "x",
      model: "m",
      ar: null,
      resolution: "1k",
      detail: d,
      refs: [],
    }));
    expect(reqs.map((r) => r.detail)).toEqual(["auto", "low", "medium", "high"]);
  });
});

describe("Provider interface — validateRequest hook", () => {
  test("optional validateRequest is acceptable on Provider", () => {
    const p: Provider = {
      name: "test",
      defaultModel: "x",
      generate: async () => ({ images: [], finishReason: "STOP" }),
      validateRequest: (req) => {
        void req;
      },
    };
    expect(p.validateRequest).toBeDefined();
  });

  test("provider without validateRequest still satisfies Provider type", () => {
    const p: Provider = {
      name: "test",
      defaultModel: "x",
      generate: async () => ({ images: [], finishReason: "STOP" }),
    };
    expect(p.validateRequest).toBeUndefined();
  });
});
