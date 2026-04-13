import { describe, test, expect } from "bun:test";
import type {
  GenerateRequest,
  GenerateResult,
  BatchCreateRequest,
  BatchJob,
  BatchResult,
  Provider,
} from "./types";

describe("Provider types", () => {
  test("GenerateRequest has required fields", () => {
    const req: GenerateRequest = {
      prompt: "A cat",
      model: "gemini-3.1-flash-image-preview",
      ar: "16:9",
      quality: "2k",
      refs: [],
      imageSize: "2K",
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
});
