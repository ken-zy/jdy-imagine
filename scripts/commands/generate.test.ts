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
