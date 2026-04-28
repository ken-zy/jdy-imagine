import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
  const defaults = {
    model: "test",
    ar: "1:1",
    resolution: "2k" as const,
    detail: "high" as const,
    refs: [],
  };

  function writePrompts(content: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "loadPrompts-"));
    const path = join(dir, "prompts.json");
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  test("single prompt creates one task", () => {
    const tasks = loadPrompts({ prompt: "A cat" }, defaults);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe("A cat");
  });

  test("prompts.json invalid resolution throws", () => {
    const path = writePrompts([{ prompt: "x", resolution: "3k" }]);
    expect(() => loadPrompts({ prompts: path }, defaults)).toThrow(
      /Invalid prompts\.json\[0\]\.resolution: 3k.*1k\|2k\|4k/,
    );
  });

  test("prompts.json invalid detail throws", () => {
    const path = writePrompts([{ prompt: "x", detail: "ultra" }]);
    expect(() => loadPrompts({ prompts: path }, defaults)).toThrow(
      /Invalid prompts\.json\[0\]\.detail: ultra.*auto\|low\|medium\|high/,
    );
  });

  test("prompts.json invalid ar throws", () => {
    const path = writePrompts([{ prompt: "x", ar: "7:13" }]);
    expect(() => loadPrompts({ prompts: path }, defaults)).toThrow(
      /Invalid prompts\.json\[0\]\.ar: 7:13/,
    );
  });

  test("prompts.json valid 13-value ar accepted", () => {
    const path = writePrompts([{ prompt: "x", ar: "21:9" }]);
    const tasks = loadPrompts({ prompts: path }, defaults);
    expect(tasks[0].ar).toBe("21:9");
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
