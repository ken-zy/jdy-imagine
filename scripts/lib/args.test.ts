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

describe("parseArgs --edit / --mask", () => {
  test("parses --edit", () => {
    const args = parseArgs(["generate", "--prompt", "x", "--edit", "/tmp/e.png"]);
    expect(args.flags.edit).toBe("/tmp/e.png");
  });
  test("parses --mask", () => {
    const args = parseArgs([
      "generate", "--prompt", "x", "--edit", "/tmp/e.png", "--mask", "/tmp/m.png",
    ]);
    expect(args.flags.mask).toBe("/tmp/m.png");
    expect(args.flags.edit).toBe("/tmp/e.png");
  });
});

describe("args resolution/detail/ar (Task 1.2 additive)", () => {
  test("parses --resolution 4k --detail high", () => {
    const a = parseArgs(["generate", "--prompt", "x", "--resolution", "4k", "--detail", "high"]);
    expect(a.flags.resolution).toBe("4k");
    expect(a.flags.detail).toBe("high");
  });

  test("parses --resolution 1k", () => {
    const a = parseArgs(["generate", "--prompt", "x", "--resolution", "1k"]);
    expect(a.flags.resolution).toBe("1k");
  });

  test("parses --detail auto/low/medium/high", () => {
    for (const d of ["auto", "low", "medium", "high"]) {
      const a = parseArgs(["generate", "--prompt", "x", "--detail", d]);
      expect(a.flags.detail).toBe(d);
    }
  });

  test("rejects invalid --resolution", () => {
    expect(() => parseArgs(["generate", "--prompt", "x", "--resolution", "8k"])).toThrow();
  });

  test("rejects invalid --detail", () => {
    expect(() => parseArgs(["generate", "--prompt", "x", "--detail", "ultra"])).toThrow();
  });

  test("accepts all 13 ar values", () => {
    const ars = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "2:1", "1:2", "21:9", "9:21"];
    for (const ar of ars) {
      const a = parseArgs(["generate", "--prompt", "x", "--ar", ar]);
      expect(a.flags.ar).toBe(ar);
    }
  });

  test("rejects invalid --ar", () => {
    expect(() => parseArgs(["generate", "--prompt", "x", "--ar", "7:13"])).toThrow();
  });

  test("legacy --quality flag still works (deprecated; throws in Task 1.6)", () => {
    const a = parseArgs(["generate", "--prompt", "x", "--quality", "2k"]);
    expect(a.flags.quality).toBe("2k");
  });
});
