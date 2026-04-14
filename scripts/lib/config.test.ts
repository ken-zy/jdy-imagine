import { describe, test, expect } from "bun:test";
import { parseExtendMd, parseDotEnv, mergeConfig } from "./config";

describe("parseExtendMd", () => {
  test("parses YAML front matter", () => {
    const content = `---
default_provider: google
default_model: gemini-3.1-flash-image-preview
default_quality: 2k
default_ar: "1:1"
---`;
    const result = parseExtendMd(content);
    expect(result.default_provider).toBe("google");
    expect(result.default_model).toBe("gemini-3.1-flash-image-preview");
    expect(result.default_quality).toBe("2k");
    expect(result.default_ar).toBe("1:1");
  });

  test("returns empty object for no front matter", () => {
    expect(parseExtendMd("just text")).toEqual({});
  });

  test("returns empty object for empty input", () => {
    expect(parseExtendMd("")).toEqual({});
  });
});

describe("parseDotEnv", () => {
  test("parses KEY=VALUE lines", () => {
    const content = `GOOGLE_API_KEY=abc123
GEMINI_API_KEY=def456
# comment
EMPTY=`;
    const result = parseDotEnv(content);
    expect(result.GOOGLE_API_KEY).toBe("abc123");
    expect(result.GEMINI_API_KEY).toBe("def456");
    expect(result.EMPTY).toBe("");
  });

  test("ignores comments and blank lines", () => {
    const result = parseDotEnv("# comment\n\nKEY=val");
    expect(Object.keys(result)).toEqual(["KEY"]);
  });

  test("strips surrounding quotes", () => {
    const result = parseDotEnv('KEY="value"\nKEY2=\'val2\'');
    expect(result.KEY).toBe("value");
    expect(result.KEY2).toBe("val2");
  });
});

describe("mergeConfig", () => {
  test("CLI flags override everything", () => {
    const config = mergeConfig(
      { model: "cli-model" },
      { default_model: "ext-model" },
      { GOOGLE_IMAGE_MODEL: "env-model" },
    );
    expect(config.model).toBe("cli-model");
  });

  test("EXTEND.md overrides env", () => {
    const config = mergeConfig(
      {},
      { default_model: "ext-model" },
      { GOOGLE_IMAGE_MODEL: "env-model" },
    );
    expect(config.model).toBe("ext-model");
  });

  test("env overrides defaults", () => {
    const config = mergeConfig(
      {},
      {},
      { GOOGLE_IMAGE_MODEL: "env-model" },
    );
    expect(config.model).toBe("env-model");
  });

  test("built-in defaults used when nothing set", () => {
    const config = mergeConfig({}, {}, {});
    expect(config.model).toBe("gemini-3.1-flash-image-preview");
    expect(config.provider).toBe("google");
    expect(config.quality).toBe("2k");
    expect(config.ar).toBe("1:1");
  });
});
