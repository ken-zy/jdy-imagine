import { describe, test, expect } from "bun:test";
import { validateGenerateArgs, loadPrompts } from "./generate";

describe("validateGenerateArgs", () => {
  test("requires --prompt or --prompts", () => {
    expect(() => validateGenerateArgs({})).toThrow("--prompt or --prompts is required");
  });

  test("accepts --prompt", () => {
    expect(() => validateGenerateArgs({ prompt: "A cat" })).not.toThrow();
  });

  test("accepts --prompts", () => {
    expect(() => validateGenerateArgs({ prompts: "prompts.json" })).not.toThrow();
  });

  test("rejects both --prompt and --prompts", () => {
    expect(() =>
      validateGenerateArgs({ prompt: "A cat", prompts: "prompts.json" }),
    ).toThrow("Cannot use both --prompt and --prompts");
  });
});

describe("chain mode edge cases", () => {
  test("validateGenerateArgs allows --chain without --prompts for single prompt", () => {
    expect(() => validateGenerateArgs({ prompt: "A cat" })).not.toThrow();
  });

  test("validateGenerateArgs still requires prompt or prompts", () => {
    expect(() => validateGenerateArgs({})).toThrow("--prompt or --prompts is required");
  });
});

describe("loadPrompts", () => {
  test("single prompt creates one task", () => {
    const tasks = loadPrompts({ prompt: "A cat" }, {
      model: "test",
      ar: "1:1",
      quality: "2k" as const,
      refs: [],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe("A cat");
  });
});

import { validateProviderCapabilities } from "./generate";

describe("validateProviderCapabilities", () => {
  const fakeProvider = (name: string, hasChain = false) => ({
    name,
    defaultModel: "m",
    generate: async () => ({ images: [], finishReason: "STOP" as const }),
    generateChained: hasChain ? (async () => ({ images: [], finishReason: "STOP" as const })) : undefined,
  });

  // Old `provider.name === "openai"` guard removed in Task 1.6 — mask is a capability now.
  // google still throws via its internal rejectMask; apimart accepts mask (Task 2.4).

  test("mask without edit/ref throws", () => {
    expect(() => validateProviderCapabilities(fakeProvider("openai") as any, {
      mask: "/tmp/m.png",
    })).toThrow(/mask.*requires/i);
  });

  test("mask with edit OK for openai", () => {
    expect(() => validateProviderCapabilities(fakeProvider("openai") as any, {
      mask: "/tmp/m.png", edit: "/tmp/e.png",
    })).not.toThrow();
  });

  test("mask with ref OK for openai", () => {
    expect(() => validateProviderCapabilities(fakeProvider("openai") as any, {
      mask: "/tmp/m.png", ref: ["/tmp/r.png"],
    })).not.toThrow();
  });

  test("mask with ref OK for apimart (no command-layer block)", () => {
    expect(() => validateProviderCapabilities(fakeProvider("apimart") as any, {
      mask: "/tmp/m.png", ref: ["/tmp/r.png"],
    })).not.toThrow();
  });

  test("chain on provider without generateChained throws", () => {
    expect(() => validateProviderCapabilities(fakeProvider("openai", false) as any, {
      chain: true,
    })).toThrow(/chain/i);
  });

  test("chain on provider with generateChained OK", () => {
    expect(() => validateProviderCapabilities(fakeProvider("google", true) as any, {
      chain: true,
    })).not.toThrow();
  });
});
