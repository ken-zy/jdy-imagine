import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { saveManifest, loadManifest, writeResults, BATCH_PAYLOAD_LIMIT, type BatchManifest } from "./batch";
import type { BatchResult } from "../providers/types";

describe("saveManifest", () => {
  test("persists manifest to .jdy-imagine-batch dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-test-"));
    const manifest: BatchManifest = {
      jobId: "batches/abc123",
      model: "gemini-3.1-flash-image-preview",
      createTime: "2026-04-13T10:00:00Z",
      outdir: dir,
      tasks: [
        { key: "001-sunset", prompt: "A sunset over mountains", ar: "16:9" },
      ],
    };

    saveManifest(dir, manifest);

    const manifestDir = join(dir, ".jdy-imagine-batch");
    expect(existsSync(manifestDir)).toBe(true);

    const files = readdirSync(manifestDir).filter(f => f.endsWith(".json"));
    expect(files).toHaveLength(1);
  });
});

describe("loadManifest", () => {
  test("loads saved manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-test-"));
    const manifest: BatchManifest = {
      jobId: "batches/abc123",
      model: "test-model",
      createTime: "2026-04-13T10:00:00Z",
      outdir: dir,
      tasks: [{ key: "001-cat", prompt: "A cat" }],
    };

    saveManifest(dir, manifest);
    const loaded = loadManifest(dir, "batches/abc123");
    expect(loaded).not.toBeNull();
    expect(loaded!.jobId).toBe("batches/abc123");
    expect(loaded!.tasks).toHaveLength(1);
  });

  test("returns null for missing manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-test-"));
    expect(loadManifest(dir, "batches/missing")).toBeNull();
  });
});

describe("writeResults", () => {
  test("multi-image results get -a, -b suffixes", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-wr-"));
    const results: BatchResult[] = [
      {
        key: "001-cat",
        result: {
          images: [
            { data: new Uint8Array([1]), mimeType: "image/png" },
            { data: new Uint8Array([2]), mimeType: "image/png" },
          ],
          finishReason: "STOP",
        },
      },
    ];
    writeResults(results, dir, false, null);
    expect(existsSync(join(dir, "001-cat-a.png"))).toBe(true);
    expect(existsSync(join(dir, "001-cat-b.png"))).toBe(true);
  });

  test("JPEG mimeType produces .jpg extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-wr-"));
    const results: BatchResult[] = [
      {
        key: "001-photo",
        result: {
          images: [{ data: new Uint8Array([1]), mimeType: "image/jpeg" }],
          finishReason: "STOP",
        },
      },
    ];
    writeResults(results, dir, false, null);
    expect(existsSync(join(dir, "001-photo.jpg"))).toBe(true);
  });

  test("collision handling avoids overwriting", () => {
    const dir = mkdtempSync(join(tmpdir(), "jdy-imagine-wr-"));
    writeFileSync(join(dir, "001-cat.png"), "existing");
    const results: BatchResult[] = [
      {
        key: "001-cat",
        result: {
          images: [{ data: new Uint8Array([1]), mimeType: "image/png" }],
          finishReason: "STOP",
        },
      },
    ];
    writeResults(results, dir, false, null);
    expect(existsSync(join(dir, "001-cat-2.png"))).toBe(true);
  });
});

describe("payload estimation", () => {
  test("payload limit is 100MB for file-based input", () => {
    expect(BATCH_PAYLOAD_LIMIT).toBe(100 * 1024 * 1024);
  });

  test("payload limit is not the old 20MB inline limit", () => {
    expect(BATCH_PAYLOAD_LIMIT).toBeGreaterThan(20 * 1024 * 1024);
  });
});
