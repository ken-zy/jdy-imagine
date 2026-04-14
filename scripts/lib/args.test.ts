import { describe, test, expect } from "bun:test";
import { parseArgs } from "./args";

describe("parseArgs", () => {
  test("parses generate command with all flags", () => {
    const result = parseArgs([
      "generate",
      "--prompt", "A cat",
      "--outdir", "./images",
      "--ar", "16:9",
      "--quality", "2k",
      "--model", "gemini-3-pro-image-preview",
      "--ref", "source.png",
    ]);
    expect(result.command).toBe("generate");
    expect(result.flags.prompt).toBe("A cat");
    expect(result.flags.outdir).toBe("./images");
    expect(result.flags.ar).toBe("16:9");
    expect(result.flags.quality).toBe("2k");
    expect(result.flags.model).toBe("gemini-3-pro-image-preview");
    expect(result.flags.ref).toEqual(["source.png"]);
  });

  test("parses -m alias for --model", () => {
    const result = parseArgs(["generate", "-m", "test-model", "--prompt", "x"]);
    expect(result.flags.model).toBe("test-model");
  });

  test("parses -o alias for --outdir", () => {
    const result = parseArgs(["generate", "-o", "./out", "--prompt", "x"]);
    expect(result.flags.outdir).toBe("./out");
  });

  test("parses batch submit command", () => {
    const result = parseArgs([
      "batch", "submit", "prompts.json",
      "--outdir", "./images",
      "--async",
    ]);
    expect(result.command).toBe("batch");
    expect(result.subcommand).toBe("submit");
    expect(result.positional).toBe("prompts.json");
    expect(result.flags.async).toBe(true);
  });

  test("parses batch status command", () => {
    const result = parseArgs(["batch", "status", "batches/abc123"]);
    expect(result.command).toBe("batch");
    expect(result.subcommand).toBe("status");
    expect(result.positional).toBe("batches/abc123");
  });

  test("parses --json flag", () => {
    const result = parseArgs(["generate", "--prompt", "x", "--json"]);
    expect(result.flags.json).toBe(true);
  });

  test("parses --prompts for multi-prompt mode", () => {
    const result = parseArgs(["generate", "--prompts", "prompts.json"]);
    expect(result.flags.prompts).toBe("prompts.json");
  });

  test("parses multiple --ref flags", () => {
    const result = parseArgs([
      "generate", "--prompt", "x",
      "--ref", "a.png", "--ref", "b.png",
    ]);
    expect(result.flags.ref).toEqual(["a.png", "b.png"]);
  });

  test("defaults outdir to .", () => {
    const result = parseArgs(["generate", "--prompt", "x"]);
    expect(result.flags.outdir).toBe(".");
  });
});

describe("--chain flag", () => {
  test("defaults to false", () => {
    const result = parseArgs(["generate", "--prompt", "test"]);
    expect(result.flags.chain).toBe(false);
  });

  test("sets chain to true", () => {
    const result = parseArgs(["generate", "--prompts", "p.json", "--chain"]);
    expect(result.flags.chain).toBe(true);
  });
});

describe("--character flag", () => {
  test("defaults to undefined", () => {
    const result = parseArgs(["generate", "--prompt", "test"]);
    expect(result.flags.character).toBeUndefined();
  });

  test("parses character path", () => {
    const result = parseArgs([
      "generate",
      "--prompt",
      "test",
      "--character",
      "model-a.json",
    ]);
    expect(result.flags.character).toBe("model-a.json");
  });

  test("works with batch command", () => {
    const result = parseArgs([
      "batch",
      "submit",
      "prompts.json",
      "--character",
      "char.json",
    ]);
    expect(result.flags.character).toBe("char.json");
  });
});
