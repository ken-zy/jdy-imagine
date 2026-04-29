import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createApimartProvider } from "./apimart";
import type { GenerateRequest } from "./types";

const config = {
  apiKey: "k",
  baseUrl: "https://api.apimart.test",
  model: "gpt-image-2-official",
};

const fastOpts = {
  pollInitialMs: 0,
  pollIntervalMs: 0,
  pollTimeoutMs: 1000,
  sleep: async () => {},
  now: () => 0,
};

function baseReq(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    prompt: "x",
    model: "gpt-image-2-official",
    ar: "1:1",
    resolution: "2k",
    detail: "high",
    refs: [],
    ...overrides,
  };
}

type Handler = (req: Request) => Response | Promise<Response>;
let originalFetch: typeof globalThis.fetch;
function setFetch(h: Handler) {
  globalThis.fetch = ((input: any, init: any) =>
    Promise.resolve(h(new Request(input, init)))
  ) as any;
}

beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe("apimart validateRequest", () => {
  const provider = createApimartProvider(config);

  test.each(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "2:1", "1:2", "21:9", "9:21"])(
    "accepts ar %s at 2k",
    (ar) => {
      expect(() => provider.validateRequest!(baseReq({ ar }))).not.toThrow();
    },
  );

  test("rejects ar 7:13", () => {
    expect(() => provider.validateRequest!(baseReq({ ar: "7:13" }))).toThrow(/apimart.*7:13/);
  });

  test.each(["16:9", "9:16", "2:1", "1:2", "21:9", "9:21"])(
    "accepts 4k + ar %s",
    (ar) => {
      expect(() => provider.validateRequest!(baseReq({ ar, resolution: "4k" }))).not.toThrow();
    },
  );

  test.each(["1:1", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5"])(
    "rejects 4k + non-supported ar %s",
    (ar) => {
      expect(() => provider.validateRequest!(baseReq({ ar, resolution: "4k" }))).toThrow(/4k/);
    },
  );
});

describe("apimart generate (text-only)", () => {
  test("submit + poll completed → returns image bytes", async () => {
    const calls: string[] = [];
    setFetch((req) => {
      calls.push(req.url);
      if (req.url.endsWith("/v1/images/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "task-1" }] }), { status: 200 });
      }
      if (req.url.endsWith("/v1/tasks/task-1")) {
        return new Response(JSON.stringify({
          data: { status: "completed", result: { images: [{ url: ["https://cdn.apimart/abc.png"] }] } },
        }), { status: 200 });
      }
      if (req.url === "https://cdn.apimart/abc.png") {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const provider = createApimartProvider(config, fastOpts);
    const result = await provider.generate(baseReq());
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.finishReason).toBe("STOP");
    expect(calls.some(u => u.endsWith("/v1/images/generations"))).toBe(true);
    expect(calls.some(u => u.endsWith("/v1/tasks/task-1"))).toBe(true);
  });

  test("status union: submitted → in_progress → completed", async () => {
    const states = ["submitted", "in_progress", "completed"];
    let pollCount = 0;
    setFetch((req) => {
      if (req.url.includes("/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "t" }] }), { status: 200 });
      }
      if (req.url.includes("/tasks/")) {
        const s = states[pollCount++] ?? "completed";
        if (s === "completed") {
          return new Response(JSON.stringify({
            data: { status: "completed", result: { images: [{ url: ["https://cdn/a.png"] }] } },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: { status: s } }), { status: 200 });
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    const provider = createApimartProvider(config, fastOpts);
    const result = await provider.generate(baseReq());
    expect(result.finishReason).toBe("STOP");
    expect(pollCount).toBe(3);
  });

  test("status union: pending/processing aliases", async () => {
    const states = ["pending", "processing", "completed"];
    let pollCount = 0;
    setFetch((req) => {
      if (req.url.includes("/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "t" }] }), { status: 200 });
      }
      if (req.url.includes("/tasks/")) {
        const s = states[pollCount++] ?? "completed";
        if (s === "completed") {
          return new Response(JSON.stringify({
            data: { status: "completed", result: { images: [{ url: "https://cdn/a.png" }] } },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: { status: s } }), { status: 200 });
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    const provider = createApimartProvider(config, fastOpts);
    const result = await provider.generate(baseReq());
    expect(result.finishReason).toBe("STOP");
    expect(pollCount).toBe(3);
  });

  test("download url accepts both string and string[] shapes", async () => {
    setFetch((req) => {
      if (req.url.includes("/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "t" }] }), { status: 200 });
      }
      if (req.url.includes("/tasks/")) {
        return new Response(JSON.stringify({
          data: { status: "completed", result: { images: [{ url: "https://cdn/single.png" }] } },
        }), { status: 200 });
      }
      return new Response(new Uint8Array([0x89, 0x50]), { status: 200 });
    });
    const provider = createApimartProvider(config, fastOpts);
    const result = await provider.generate(baseReq());
    expect(result.finishReason).toBe("STOP");
  });

  test("failed + error.message=moderation_blocked → SAFETY", async () => {
    setFetch((req) => {
      if (req.url.includes("/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "t" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { status: "failed", error: { message: "moderation_blocked", type: "policy_violation", code: 400 } },
      }), { status: 200 });
    });
    const provider = createApimartProvider(config, fastOpts);
    const result = await provider.generate(baseReq());
    expect(result.finishReason).toBe("SAFETY");
    expect(result.images).toHaveLength(0);
    expect(result.safetyInfo?.reason).toContain("moderation_blocked");
  });

  test("failed + fail_reason → ERROR (not safety)", async () => {
    setFetch((req) => {
      if (req.url.includes("/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "t" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { status: "failed", fail_reason: "internal server" },
      }), { status: 200 });
    });
    const provider = createApimartProvider(config, fastOpts);
    const result = await provider.generate(baseReq());
    expect(result.finishReason).toBe("ERROR");
    expect(result.safetyInfo?.reason).toBe("internal server");
  });

  test("cancelled → ERROR with reason 'cancelled'", async () => {
    setFetch((req) => {
      if (req.url.includes("/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "t" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { status: "cancelled" } }), { status: 200 });
    });
    const provider = createApimartProvider(config, fastOpts);
    const result = await provider.generate(baseReq());
    expect(result.finishReason).toBe("ERROR");
    expect(result.safetyInfo?.reason).toContain("cancelled");
  });

  test("timeout → throw with task_id in message", async () => {
    let mockTime = 0;
    setFetch((req) => {
      if (req.url.includes("/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "task-stuck" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { status: "processing" } }), { status: 200 });
    });
    const provider = createApimartProvider(config, {
      pollInitialMs: 1,
      pollIntervalMs: 1,
      pollTimeoutMs: 50,
      sleep: async (ms) => { mockTime += ms; },
      now: () => mockTime,
    });
    await expect(provider.generate(baseReq())).rejects.toThrow(/task_id=task-stuck/);
  });

  test("submit 401 → throw auth", async () => {
    setFetch(() => new Response(JSON.stringify({ message: "invalid token" }), { status: 401 }));
    const provider = createApimartProvider(config, fastOpts);
    await expect(provider.generate(baseReq())).rejects.toThrow(/auth.*401/i);
  });

  test("submit 402 → throw insufficient balance", async () => {
    setFetch(() => new Response(JSON.stringify({}), { status: 402 }));
    const provider = createApimartProvider(config, fastOpts);
    await expect(provider.generate(baseReq())).rejects.toThrow(/insufficient balance/);
  });

  test("submit 502 retried → eventually 200", async () => {
    let n = 0;
    setFetch((req) => {
      if (req.url.includes("/generations")) {
        n++;
        if (n < 3) return new Response("upstream", { status: 502 });
        return new Response(JSON.stringify({ data: [{ task_id: "t" }] }), { status: 200 });
      }
      if (req.url.includes("/tasks/")) {
        return new Response(JSON.stringify({
          data: { status: "completed", result: { images: [{ url: "https://cdn/a.png" }] } },
        }), { status: 200 });
      }
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    const provider = createApimartProvider(config, fastOpts);
    const result = await provider.generate(baseReq());
    expect(result.finishReason).toBe("STOP");
    expect(n).toBe(3);
  });

  test("submit 502 exhausted → throw", async () => {
    setFetch(() => new Response("dead", { status: 502 }));
    const provider = createApimartProvider(config, fastOpts);
    await expect(provider.generate(baseReq())).rejects.toThrow(/apimart submit failed/);
  });

  test("400 with safety message → SAFETY result", async () => {
    setFetch(() => new Response(JSON.stringify({
      error: { message: "moderation_blocked", type: "policy_violation", code: 400 },
    }), { status: 400 }));
    const provider = createApimartProvider(config, fastOpts);
    const result = await provider.generate(baseReq());
    expect(result.finishReason).toBe("SAFETY");
    expect(result.safetyInfo?.reason).toContain("moderation");
  });

  test("400 without safety keyword → ERROR result", async () => {
    setFetch(() => new Response(JSON.stringify({
      error: { message: "invalid prompt formatting", code: 400 },
    }), { status: 400 }));
    const provider = createApimartProvider(config, fastOpts);
    const result = await provider.generate(baseReq());
    expect(result.finishReason).toBe("ERROR");
    expect(result.safetyInfo?.reason).toContain("invalid prompt");
  });

  test("submit response missing task_id → throw", async () => {
    setFetch(() => new Response(JSON.stringify({ data: [{}] }), { status: 200 }));
    const provider = createApimartProvider(config, fastOpts);
    await expect(provider.generate(baseReq())).rejects.toThrow(/missing task_id/);
  });
});

describe("apimart pollTask injectable timing", () => {
  test("uses injected sleep/now (no real wait)", async () => {
    const sleeps: number[] = [];
    let mockTime = 0;
    setFetch((req) => {
      if (req.url.includes("/generations")) {
        return new Response(JSON.stringify({ data: [{ task_id: "stuck" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { status: "processing" } }), { status: 200 });
    });
    const provider = createApimartProvider(config, {
      pollInitialMs: 10,
      pollIntervalMs: 5,
      pollTimeoutMs: 50,
      sleep: async (ms) => { sleeps.push(ms); mockTime += ms; },
      now: () => mockTime,
    });
    const t0 = process.hrtime.bigint();
    await expect(provider.generate(baseReq())).rejects.toThrow(/task_id=stuck/);
    const elapsedMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    expect(elapsedMs).toBeLessThan(500);
    expect(sleeps[0]).toBe(10);
    expect(sleeps.slice(1).every(s => s === 5)).toBe(true);
  });
});

describe("apimart image input not yet implemented (Task 2.4 placeholder)", () => {
  test("ref → throws not yet implemented", async () => {
    const provider = createApimartProvider(config, fastOpts);
    await expect(provider.generate(baseReq({ refs: ["/tmp/x.png"] }))).rejects.toThrow(/not yet implemented/);
  });
});
