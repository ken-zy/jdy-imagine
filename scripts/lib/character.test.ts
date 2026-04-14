// scripts/lib/character.test.ts
import { describe, test, expect } from "bun:test";
import { loadCharacter, applyCharacterPrompt, mergeCharacterRefs } from "./character";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("loadCharacter", () => {
  test("loads valid character profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "char-"));
    const refPath = join(dir, "front.png");
    writeFileSync(refPath, Buffer.from([0x89, 0x50]));
    const charPath = join(dir, "char.json");
    writeFileSync(
      charPath,
      JSON.stringify({
        name: "model-A",
        description: "25-year-old woman, oval face",
        negative: "Do not change face",
        references: ["./front.png"],
      }),
    );
    const profile = loadCharacter(charPath);
    expect(profile.name).toBe("model-A");
    expect(profile.description).toBe("25-year-old woman, oval face");
    expect(profile.negative).toBe("Do not change face");
    expect(profile.references).toHaveLength(1);
    expect(profile.references[0]).toBe(refPath); // resolved to absolute
  });

  test("throws on missing description", () => {
    const dir = mkdtempSync(join(tmpdir(), "char-"));
    const charPath = join(dir, "char.json");
    writeFileSync(charPath, JSON.stringify({ name: "bad" }));
    expect(() => loadCharacter(charPath)).toThrow("description");
  });

  test("throws on missing file", () => {
    expect(() => loadCharacter("/nonexistent/char.json")).toThrow();
  });

  test("defaults references to empty array", () => {
    const dir = mkdtempSync(join(tmpdir(), "char-"));
    const charPath = join(dir, "char.json");
    writeFileSync(
      charPath,
      JSON.stringify({ description: "a woman" }),
    );
    const profile = loadCharacter(charPath);
    expect(profile.references).toEqual([]);
  });
});

describe("applyCharacterPrompt", () => {
  test("prepends description and negative to prompt", () => {
    const result = applyCharacterPrompt("wearing red dress", {
      description: "25-year-old woman",
      negative: "Do not change face",
      references: [],
    });
    expect(result).toBe(
      "25-year-old woman Do not change face wearing red dress",
    );
  });

  test("prepends description only when no negative", () => {
    const result = applyCharacterPrompt("wearing red dress", {
      description: "25-year-old woman",
      references: [],
    });
    expect(result).toBe("25-year-old woman wearing red dress");
  });
});

describe("mergeCharacterRefs", () => {
  test("merges character refs before task refs", () => {
    const result = mergeCharacterRefs(["/task/ref.png"], {
      description: "desc",
      references: ["/char/front.png", "/char/side.png"],
    });
    expect(result).toEqual([
      "/char/front.png",
      "/char/side.png",
      "/task/ref.png",
    ]);
  });

  test("deduplicates refs by absolute path", () => {
    const result = mergeCharacterRefs(["/shared/ref.png"], {
      description: "desc",
      references: ["/shared/ref.png", "/char/side.png"],
    });
    expect(result).toEqual(["/shared/ref.png", "/char/side.png"]);
  });
});
