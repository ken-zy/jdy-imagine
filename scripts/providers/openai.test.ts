import { describe, test, expect, mock, afterEach } from "bun:test";
import {
  mapToOpenAISize,
  mapToOpenAIQuality,
  mapOpenAIBatchState,
  mapOpenAIError,
  buildGenerationsPayload,
  buildEditFormData,
  parseOpenAIResponse,
  buildOpenAIBatchJsonl,
  createOpenAIProvider,
} from "./openai";

describe("mapToOpenAISize", () => {
  const cases: Array<["normal" | "2k", string, string]> = [
    ["normal", "1:1", "1024x1024"],
    ["normal", "16:9", "1536x1024"],
    ["normal", "9:16", "1024x1536"],
    ["normal", "3:2", "1536x1024"],
    ["normal", "2:3", "1024x1536"],
    ["normal", "4:3", "1280x960"],
    ["normal", "3:4", "960x1280"],
    ["2k", "1:1", "2048x2048"],
    ["2k", "16:9", "2048x1152"],
    ["2k", "9:16", "1152x2048"],
    ["2k", "3:2", "2304x1536"],
    ["2k", "2:3", "1536x2304"],
    ["2k", "4:3", "2048x1536"],
    ["2k", "3:4", "1536x2048"],
  ];
  for (const [q, ar, size] of cases) {
    test(`${q} + ${ar} -> ${size}`, () => {
      expect(mapToOpenAISize(q, ar)).toBe(size);
    });
  }
  test("null ar defaults to 1:1", () => {
    expect(mapToOpenAISize("normal", null)).toBe("1024x1024");
  });
  test("unknown ar throws", () => {
    expect(() => mapToOpenAISize("normal", "100:1")).toThrow(/unsupported.*ar/i);
  });
});

describe("mapToOpenAIQuality", () => {
  test("normal -> medium", () => expect(mapToOpenAIQuality("normal")).toBe("medium"));
  test("2k -> high", () => expect(mapToOpenAIQuality("2k")).toBe("high"));
});

describe("mapOpenAIBatchState", () => {
  test("validating -> pending", () => expect(mapOpenAIBatchState("validating")).toBe("pending"));
  test("in_progress -> running", () => expect(mapOpenAIBatchState("in_progress")).toBe("running"));
  test("finalizing -> running", () => expect(mapOpenAIBatchState("finalizing")).toBe("running"));
  test("cancelling -> running", () => expect(mapOpenAIBatchState("cancelling")).toBe("running"));
  test("completed -> succeeded", () => expect(mapOpenAIBatchState("completed")).toBe("succeeded"));
  test("failed -> failed", () => expect(mapOpenAIBatchState("failed")).toBe("failed"));
  test("expired -> expired", () => expect(mapOpenAIBatchState("expired")).toBe("expired"));
  test("cancelled -> cancelled", () => expect(mapOpenAIBatchState("cancelled")).toBe("cancelled"));
  test("unknown state -> pending (conservative)", () => {
    expect(mapOpenAIBatchState("future_state")).toBe("pending");
  });
});

describe("mapOpenAIError", () => {
  test("moderation_blocked -> SAFETY", () => {
    const r = mapOpenAIError({ code: "moderation_blocked", message: "blocked" });
    expect(r.finishReason).toBe("SAFETY");
    expect(r.safetyInfo?.reason).toBe("blocked");
  });
  test("content_policy_violation -> SAFETY", () => {
    const r = mapOpenAIError({ code: "content_policy_violation", message: "policy" });
    expect(r.finishReason).toBe("SAFETY");
  });
  test("invalid_size -> ERROR", () => {
    const r = mapOpenAIError({ code: "invalid_size", message: "bad size" });
    expect(r.finishReason).toBe("ERROR");
    expect(r.safetyInfo?.reason).toBe("bad size");
  });
  test("unknown error code -> ERROR", () => {
    const r = mapOpenAIError({ code: "unknown_code", message: "msg" });
    expect(r.finishReason).toBe("ERROR");
  });
});

describe("buildGenerationsPayload", () => {
  test("text-only payload structure", () => {
    const payload = buildGenerationsPayload({
      prompt: "cat",
      model: "gpt-image-2",
      ar: "1:1",
      quality: "normal",
      refs: [],
      imageSize: "1K",
    });
    expect(payload.prompt).toBe("cat");
    expect(payload.model).toBe("gpt-image-2");
    expect(payload.size).toBe("1024x1024");
    expect(payload.quality).toBe("medium");
    expect(payload.n).toBe(1);
    expect(payload.output_format).toBe("png");
  });
});

describe("parseOpenAIResponse", () => {
  test("decodes b64_json into Uint8Array", () => {
    const fake = Buffer.from("FAKE-PNG-DATA").toString("base64");
    const r = parseOpenAIResponse({ data: [{ b64_json: fake }] });
    expect(r.images.length).toBe(1);
    expect(r.images[0].mimeType).toBe("image/png");
    expect(r.finishReason).toBe("STOP");
  });
  test("empty data -> OTHER", () => {
    const r = parseOpenAIResponse({ data: [] });
    expect(r.images.length).toBe(0);
    expect(r.finishReason).toBe("OTHER");
  });
});

describe("buildOpenAIBatchJsonl", () => {
  test("produces correct format with custom_id, method, url, body", () => {
    const { data, keys } = buildOpenAIBatchJsonl([
      { prompt: "cat", model: "gpt-image-2", ar: "1:1", quality: "normal", refs: [], imageSize: "1K" },
      { prompt: "dog", model: "gpt-image-2", ar: "16:9", quality: "2k", refs: [], imageSize: "2K" },
    ]);
    const text = new TextDecoder().decode(data);
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);
    const line0 = JSON.parse(lines[0]);
    expect(line0.custom_id).toBe(keys[0]);
    expect(line0.method).toBe("POST");
    expect(line0.url).toBe("/v1/images/generations");
    expect(line0.body.prompt).toBe("cat");
    expect(line0.body.size).toBe("1024x1024");
    expect(line0.body.quality).toBe("medium");
    const line1 = JSON.parse(lines[1]);
    expect(line1.body.size).toBe("2048x1152");
    expect(line1.body.quality).toBe("high");
  });
});

describe("buildEditFormData", () => {
  test("editTarget non-empty: appears first in image[]", async () => {
    const tmpEdit = "/tmp/jdy-openai-edit-formdata.png";
    const tmpRef = "/tmp/jdy-openai-ref-formdata.png";
    await Bun.write(tmpEdit, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    await Bun.write(tmpRef, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    const fd = buildEditFormData({
      prompt: "x",
      model: "gpt-image-2",
      ar: "1:1",
      quality: "normal",
      refs: [tmpRef],
      imageSize: "1K",
      editTarget: tmpEdit,
    });
    const images = fd.getAll("image[]") as File[];
    expect(images.length).toBe(2);
    expect((images[0] as any).name).toContain("edit");
    expect((images[1] as any).name).toContain("ref");
  });

  test("mask appears as separate field", async () => {
    const tmpEdit = "/tmp/jdy-openai-edit2.png";
    const tmpMask = "/tmp/jdy-openai-mask2.png";
    await Bun.write(tmpEdit, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    await Bun.write(tmpMask, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    const fd = buildEditFormData({
      prompt: "x",
      model: "gpt-image-2",
      ar: "1:1",
      quality: "normal",
      refs: [],
      imageSize: "1K",
      editTarget: tmpEdit,
      mask: tmpMask,
    });
    expect(fd.get("mask")).toBeDefined();
  });
});

describe("createOpenAIProvider routing", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("text-only -> /v1/images/generations (JSON POST)", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedContentType = "";
    globalThis.fetch = mock(async (url: any, init: any) => {
      capturedUrl = url.toString();
      capturedMethod = init.method;
      const reqHeaders = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
      capturedContentType = reqHeaders.get("Content-Type") ?? "";
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("PNG").toString("base64") }],
      }), { status: 200 });
    }) as any;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    const result = await provider.generate({
      prompt: "cat", model: "gpt-image-2", ar: "1:1", quality: "normal",
      refs: [], imageSize: "1K",
    });
    expect(capturedUrl).toContain("/v1/images/generations");
    expect(capturedMethod).toBe("POST");
    expect(capturedContentType).toBe("application/json");
    expect(result.images.length).toBe(1);
    expect(result.finishReason).toBe("STOP");
  });

  test("refs only -> /v1/images/edits (multipart)", async () => {
    const tmpRef = "/tmp/jdy-openai-routing-ref.png";
    await Bun.write(tmpRef, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    let capturedUrl = "";
    let capturedBodyIsFormData = false;
    globalThis.fetch = mock(async (url: any, init: any) => {
      capturedUrl = url.toString();
      capturedBodyIsFormData = init.body instanceof FormData;
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("PNG").toString("base64") }],
      }), { status: 200 });
    }) as any;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    await provider.generate({
      prompt: "blue", model: "gpt-image-2", ar: "1:1", quality: "normal",
      refs: [tmpRef], imageSize: "1K",
    });
    expect(capturedUrl).toContain("/v1/images/edits");
    expect(capturedBodyIsFormData).toBe(true);
  });

  test("editTarget + mask -> /v1/images/edits", async () => {
    const tmpEdit = "/tmp/jdy-openai-routing-edit.png";
    const tmpMask = "/tmp/jdy-openai-routing-mask.png";
    await Bun.write(tmpEdit, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    await Bun.write(tmpMask, new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: any) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("PNG").toString("base64") }],
      }), { status: 200 });
    }) as any;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    await provider.generate({
      prompt: "fix", model: "gpt-image-2", ar: "1:1", quality: "normal",
      refs: [], imageSize: "1K", editTarget: tmpEdit, mask: tmpMask,
    });
    expect(capturedUrl).toContain("/v1/images/edits");
  });

  test("error 400 moderation_blocked -> SAFETY result", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: { code: "moderation_blocked", message: "no" } }), { status: 400 }),
    ) as any;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    const r = await provider.generate({
      prompt: "x", model: "gpt-image-2", ar: "1:1", quality: "normal",
      refs: [], imageSize: "1K",
    });
    expect(r.finishReason).toBe("SAFETY");
    expect(r.safetyInfo?.reason).toBe("no");
  });

  test("error 401 throws", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }),
    ) as any;
    const provider = createOpenAIProvider({ apiKey: "bad", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    await expect(provider.generate({
      prompt: "x", model: "gpt-image-2", ar: "1:1", quality: "normal",
      refs: [], imageSize: "1K",
    })).rejects.toThrow(/auth|401/i);
  });
});

describe("createOpenAIProvider batch", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("batchCreate uploads file then creates batch", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = mock(async (url: any, init: any) => {
      const u = url.toString();
      calls.push({ url: u, method: init.method ?? "GET" });
      if (u.includes("/v1/files")) {
        return new Response(JSON.stringify({ id: "file_xyz" }), { status: 200 });
      }
      if (u.includes("/v1/batches")) {
        return new Response(JSON.stringify({
          id: "batch_abc", status: "validating", created_at: 1000,
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as any;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    const job = await provider.batchCreate!({
      model: "gpt-image-2",
      tasks: [
        { prompt: "cat", model: "gpt-image-2", ar: "1:1", quality: "normal", refs: [], imageSize: "1K" },
      ],
    });
    expect(job.id).toBe("batch_abc");
    expect(job.state).toBe("pending");
    expect(calls[0].url).toContain("/v1/files");
    expect(calls[1].url).toContain("/v1/batches");
  });

  test("batchCreate rejects tasks with refs", async () => {
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    await expect(provider.batchCreate!({
      model: "gpt-image-2",
      tasks: [
        { prompt: "x", model: "m", ar: null, quality: "normal", refs: ["/tmp/a.png"], imageSize: "1K" },
      ],
    })).rejects.toThrow(/text-only/i);
  });

  test("batchCreate rejects tasks with editTarget", async () => {
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    await expect(provider.batchCreate!({
      model: "gpt-image-2",
      tasks: [
        { prompt: "x", model: "m", ar: null, quality: "normal", refs: [], imageSize: "1K", editTarget: "/tmp/e.png" },
      ],
    })).rejects.toThrow(/text-only/i);
  });

  test("batchGet maps state and stats", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        id: "batch_abc", status: "completed", created_at: 1000,
        request_counts: { total: 5, completed: 4, failed: 1 },
        output_file_id: "file_out",
      }), { status: 200 }),
    ) as any;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    const job = await provider.batchGet!("batch_abc");
    expect(job.state).toBe("succeeded");
    expect(job.stats).toEqual({ total: 5, succeeded: 4, failed: 1 });
    expect(job.responsesFile).toBe("file_out");
  });

  test("batchFetch downloads JSONL via httpGetText (raw text)", async () => {
    const jsonlOutput =
      JSON.stringify({ custom_id: "001-cat", response: { body: { data: [{ b64_json: Buffer.from("CAT").toString("base64") }] } } }) + "\n" +
      JSON.stringify({ custom_id: "002-dog", error: { message: "blocked" } }) + "\n";
    globalThis.fetch = mock(async (url: any) => {
      const u = url.toString();
      if (u.includes("/v1/batches/")) {
        return new Response(JSON.stringify({
          id: "batch_abc", status: "completed",
          output_file_id: "file_out",
          request_counts: { total: 2 },
        }), { status: 200 });
      }
      if (u.includes("/v1/files/file_out/content")) {
        return new Response(jsonlOutput, { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as any;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    const results = await provider.batchFetch!("batch_abc");
    expect(results.length).toBe(2);
    const cat = results.find(r => r.key === "001-cat");
    const dog = results.find(r => r.key === "002-dog");
    expect(cat?.result?.images.length).toBe(1);
    expect(dog?.error).toBe("blocked");
  });

  test("batchFetch downloads BOTH output_file and error_file, merges by custom_id", async () => {
    const successOutput = JSON.stringify({
      custom_id: "001-cat",
      response: { body: { data: [{ b64_json: Buffer.from("CAT").toString("base64") }] } },
    }) + "\n";
    const errorOutput = JSON.stringify({
      custom_id: "002-dog",
      error: { message: "moderation_blocked" },
    }) + "\n";
    globalThis.fetch = mock(async (url: any) => {
      const u = url.toString();
      if (u.includes("/v1/batches/batch_mixed")) {
        return new Response(JSON.stringify({
          id: "batch_mixed", status: "completed",
          output_file_id: "file_out", error_file_id: "file_err",
          request_counts: { total: 2 },
        }), { status: 200 });
      }
      if (u.includes("/v1/files/file_out/content")) return new Response(successOutput, { status: 200 });
      if (u.includes("/v1/files/file_err/content")) return new Response(errorOutput, { status: 200 });
      return new Response("nf", { status: 404 });
    }) as any;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    const results = await provider.batchFetch!("batch_mixed");
    expect(results.length).toBe(2);
    expect(results.find(r => r.key === "001-cat")?.result?.images.length).toBe(1);
    expect(results.find(r => r.key === "002-dog")?.error).toBe("moderation_blocked");
  });

  test("batchFetch handles error-only batch (no output_file_id)", async () => {
    const errorOutput = JSON.stringify({
      custom_id: "001-x",
      error: { message: "rate_limit" },
    }) + "\n";
    globalThis.fetch = mock(async (url: any) => {
      const u = url.toString();
      if (u.includes("/v1/batches/")) {
        return new Response(JSON.stringify({
          id: "batch_err", status: "completed",
          error_file_id: "file_err",
          request_counts: { total: 1 },
        }), { status: 200 });
      }
      if (u.includes("/v1/files/file_err/content")) return new Response(errorOutput, { status: 200 });
      return new Response("nf", { status: 404 });
    }) as any;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    const results = await provider.batchFetch!("batch_err");
    expect(results.length).toBe(1);
    expect(results[0].error).toBe("rate_limit");
  });

  test("batchList returns mapped jobs", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        data: [
          { id: "batch_1", status: "in_progress", created_at: 1000 },
          { id: "batch_2", status: "completed", created_at: 2000 },
        ],
      }), { status: 200 }),
    ) as any;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    const jobs = await provider.batchList!();
    expect(jobs.length).toBe(2);
    expect(jobs[0].state).toBe("running");
    expect(jobs[1].state).toBe("succeeded");
  });

  test("batchCancel posts to /cancel", async () => {
    let calledUrl = "";
    globalThis.fetch = mock(async (url: any) => {
      calledUrl = url.toString();
      return new Response(JSON.stringify({ id: "batch_abc", status: "cancelling" }), { status: 200 });
    }) as any;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl: "https://api.openai.com", model: "gpt-image-2" });
    await provider.batchCancel!("batch_abc");
    expect(calledUrl).toContain("/v1/batches/batch_abc/cancel");
  });
});
