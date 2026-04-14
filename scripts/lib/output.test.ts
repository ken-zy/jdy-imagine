import { describe, test, expect } from "bun:test";
import { generateSlug, buildOutputPath, mimeToExt } from "./output";

describe("mimeToExt", () => {
  test("image/png -> .png", () => {
    expect(mimeToExt("image/png")).toBe(".png");
  });

  test("image/jpeg -> .jpg", () => {
    expect(mimeToExt("image/jpeg")).toBe(".jpg");
  });
});

describe("generateSlug", () => {
  test("English prompt -> lowercase hyphenated first 4 words", () => {
    expect(generateSlug("A sunset over mountains")).toBe("a-sunset-over-mountains");
  });

  test("CJK prompt -> kept as-is, first 4 tokens", () => {
    expect(generateSlug("一只可爱的猫在花园里")).toBe("一只可爱的猫在花园里");
  });

  test("long prompt -> truncated to 40 chars", () => {
    const slug = generateSlug("Create a very detailed and elaborate architectural blueprint design");
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  test("emoji prompt -> stripped, fallback if empty", () => {
    expect(generateSlug("\u{1F389}\u{1F38A}\u{1F388}")).toBe("img");
  });

  test("mixed content -> emoji stripped, words kept", () => {
    const slug = generateSlug("Hello \u{1F30D} world");
    expect(slug).toBe("hello-world");
  });

  test("OS-reserved characters stripped", () => {
    const slug = generateSlug('file: "test" <name>');
    expect(slug).not.toMatch(/[<>:"/\\|?*]/);
  });

  test("trailing dash and dot stripped", () => {
    const slug = generateSlug("test-");
    expect(slug).not.toMatch(/[-.]$/);
  });
});

describe("buildOutputPath", () => {
  test("generates NNN-slug.png pattern", () => {
    const path = buildOutputPath("/tmp/out", "a-sunset", 1);
    expect(path).toBe("/tmp/out/001-a-sunset.png");
  });

  test("zero-pads sequence number", () => {
    const path = buildOutputPath("/tmp/out", "cat", 42);
    expect(path).toBe("/tmp/out/042-cat.png");
  });

  test("uses custom extension", () => {
    const path = buildOutputPath("/tmp/out", "photo", 1, ".jpg");
    expect(path).toBe("/tmp/out/001-photo.jpg");
  });
});
