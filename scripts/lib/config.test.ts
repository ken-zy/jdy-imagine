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
    expect(config.resolution).toBe("2k");
    expect(config.detail).toBe("high");
    expect(config.ar).toBe("1:1");
  });
});

describe("mergeConfig resolution/detail (Task 1.3 additive)", () => {
  test("default resolution=2k, detail=high", () => {
    const c = mergeConfig({}, {}, {});
    expect(c.resolution).toBe("2k");
    expect(c.detail).toBe("high");
  });

  test("CLI flags override defaults", () => {
    const c = mergeConfig({ resolution: "4k", detail: "low" }, {}, {});
    expect(c.resolution).toBe("4k");
    expect(c.detail).toBe("low");
  });

  test("EXTEND.md default_resolution / default_detail parse", () => {
    const c = mergeConfig({}, { default_resolution: "1k", default_detail: "medium" }, {});
    expect(c.resolution).toBe("1k");
    expect(c.detail).toBe("medium");
  });

});

describe("mergeConfig apimart provider", () => {
  test("provider=apimart picks APIMART_* env", () => {
    const c = mergeConfig(
      { provider: "apimart" },
      {},
      {
        APIMART_API_KEY: "sk-am",
        APIMART_BASE_URL: "https://api.apimart.ai",
        APIMART_IMAGE_MODEL: "gpt-image-2-official",
      },
    );
    expect(c.provider).toBe("apimart");
    expect(c.apiKey).toBe("sk-am");
    expect(c.baseUrl).toBe("https://api.apimart.ai");
    expect(c.model).toBe("gpt-image-2-official");
  });

  test("apimart default baseUrl + defaultModel", () => {
    const c = mergeConfig(
      { provider: "apimart" },
      {},
      { APIMART_API_KEY: "k" },
    );
    expect(c.baseUrl).toBe("https://api.apimart.ai");
    expect(c.model).toBe("gpt-image-2-official");
  });

  test("default_model in EXTEND.md leaks across providers (documented behavior)", () => {
    // Reproduces the P1-1 risk: if user sets default_model: gemini-..., switching --provider
    // doesn't auto-reset it. Test asserts the priority order is intentional and points users
    // to --model override or per-provider env.
    const c = mergeConfig(
      { provider: "apimart" },
      { default_model: "gemini-3.1-flash-image-preview" },
      { APIMART_API_KEY: "k", APIMART_IMAGE_MODEL: "gpt-image-2-official" },
    );
    // Documented priority: cliFlags.model > extendMd.default_model > envModel > providerDefault
    expect(c.model).toBe("gemini-3.1-flash-image-preview");
    // Escape hatch: explicit --model wins.
    const c2 = mergeConfig(
      { provider: "apimart", model: "gpt-image-2-official" },
      { default_model: "gemini-3.1-flash-image-preview" },
      { APIMART_API_KEY: "k" },
    );
    expect(c2.model).toBe("gpt-image-2-official");
  });
});

describe("mergeConfig with openai provider", () => {
  test("reads OPENAI_API_KEY when provider=openai", () => {
    const c = mergeConfig(
      { provider: "openai" },
      {},
      { OPENAI_API_KEY: "sk-openai", GOOGLE_API_KEY: "should-not-be-used" },
    );
    expect(c.apiKey).toBe("sk-openai");
    expect(c.baseUrl).toBe("https://api.openai.com");
  });

  test("reads OPENAI_BASE_URL override", () => {
    const c = mergeConfig(
      { provider: "openai" },
      {},
      { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "https://proxy.example.com" },
    );
    expect(c.baseUrl).toBe("https://proxy.example.com");
  });

  test("reads OPENAI_IMAGE_MODEL override", () => {
    const c = mergeConfig(
      { provider: "openai" },
      {},
      { OPENAI_API_KEY: "k", OPENAI_IMAGE_MODEL: "gpt-image-1.5" },
    );
    expect(c.model).toBe("gpt-image-1.5");
  });

  test("model defaults to gpt-image-2 when no override for openai", () => {
    const c = mergeConfig(
      { provider: "openai" },
      {},
      { OPENAI_API_KEY: "k" },
    );
    expect(c.model).toBe("gpt-image-2");
  });

  test("google regression: model still defaults to gemini-3.1-flash-image-preview", () => {
    const c = mergeConfig(
      { provider: "google" },
      {},
      { GOOGLE_API_KEY: "k" },
    );
    expect(c.model).toBe("gemini-3.1-flash-image-preview");
    expect(c.apiKey).toBe("k");
  });
});
