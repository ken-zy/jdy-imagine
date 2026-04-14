import { execFileSync } from "child_process";
import {
  detectProxy,
  CONNECT_TIMEOUT,
  TOTAL_TIMEOUT,
  RETRY_DELAYS_HTTP,
  RETRYABLE_HTTP,
} from "./http";

const DOWNLOAD_TIMEOUT = 600_000;

async function withRetry<T>(fn: () => Promise<T>, isRetryable: (err: unknown) => boolean): Promise<T> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_HTTP.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt === RETRY_DELAYS_HTTP.length) throw err;
      await Bun.sleep(RETRY_DELAYS_HTTP[attempt]);
    }
  }
  throw new Error("Unreachable");
}

export async function uploadJsonl(
  data: Uint8Array,
  displayName: string,
  apiKey: string,
  baseUrl: string,
): Promise<string> {
  const proxy = detectProxy(process.env as Record<string, string>);
  // Retry wraps BOTH paths
  return withRetry(async () => {
    if (proxy) {
      return curlUploadJsonl(data, displayName, apiKey, baseUrl, proxy);
    }
    return fetchUploadJsonlInner(data, displayName, apiKey, baseUrl);
  }, (err) => {
    const e = err as { retryable?: boolean; name?: string };
    return e.retryable === true || e.name === "AbortError" || (err instanceof TypeError);
  });
}

async function fetchUploadJsonlInner(
  data: Uint8Array,
  displayName: string,
  apiKey: string,
  baseUrl: string,
): Promise<string> {
    // Step 1: initiate resumable upload
    const startUrl = `${baseUrl}/upload/v1beta/files`;
    const controller1 = new AbortController();
    const timeout1 = setTimeout(() => controller1.abort(), TOTAL_TIMEOUT);
    let uploadUrl: string;
    try {
      const res1 = await fetch(startUrl, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(data.byteLength),
          "X-Goog-Upload-Header-Content-Type": "application/jsonl",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: displayName } }),
        signal: controller1.signal,
      });
      if (!res1.ok) {
        const text = await res1.text().catch(() => "");
        const status = res1.status;
        if (RETRYABLE_HTTP.has(status)) throw Object.assign(new Error(`Upload start failed: HTTP ${status}`), { retryable: true });
        throw new Error(`Upload start failed: HTTP ${status} — ${text.slice(0, 200)}`);
      }
      uploadUrl = res1.headers.get("x-goog-upload-url") ?? "";
      if (!uploadUrl) throw new Error("No upload URL in response headers");
    } finally {
      clearTimeout(timeout1);
    }

    // Step 2: upload bytes and finalize
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), TOTAL_TIMEOUT);
    try {
      const res2 = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(data.byteLength),
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize",
        },
        body: data,
        signal: controller2.signal,
      });
      if (!res2.ok) {
        const text = await res2.text().catch(() => "");
        const status = res2.status;
        if (RETRYABLE_HTTP.has(status)) throw Object.assign(new Error(`Upload finalize failed: HTTP ${status}`), { retryable: true });
        throw new Error(`Upload finalize failed: HTTP ${status} — ${text.slice(0, 200)}`);
      }
      const body = (await res2.json()) as { file?: { name?: string } };
      const fileName = body.file?.name;
      if (!fileName) throw new Error("No file name in upload response");
      return fileName;
    } finally {
      clearTimeout(timeout2);
    }
}

function curlUploadJsonl(
  data: Uint8Array,
  displayName: string,
  apiKey: string,
  baseUrl: string,
  proxy: string,
): string {
  const tmpHeader = `/tmp/jdy-imagine-upload-header-${Date.now()}.tmp`;
  const tmpBody = `/tmp/jdy-imagine-upload-body-${Date.now()}.tmp`;

  try {
    require("fs").writeFileSync(tmpBody, data);

    // Step 1: initiate resumable upload
    execFileSync("curl", [
      "-s", "-D", tmpHeader,
      "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
      "--max-time", String(TOTAL_TIMEOUT / 1000),
      "-x", proxy,
      "-X", "POST",
      "-H", `x-goog-api-key: ${apiKey}`,
      "-H", "X-Goog-Upload-Protocol: resumable",
      "-H", "X-Goog-Upload-Command: start",
      "-H", `X-Goog-Upload-Header-Content-Length: ${data.byteLength}`,
      "-H", "X-Goog-Upload-Header-Content-Type: application/jsonl",
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ file: { display_name: displayName } }),
      `${baseUrl}/upload/v1beta/files`,
    ], { encoding: "utf-8" });

    const headers = require("fs").readFileSync(tmpHeader, "utf-8");
    const match = headers.match(/x-goog-upload-url:\s*(\S+)/i);
    if (!match) throw new Error("No upload URL in curl response headers");
    const uploadUrl = match[1].trim();

    // Step 2: upload finalize
    const output = execFileSync("curl", [
      "-s",
      "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
      "--max-time", String(TOTAL_TIMEOUT / 1000),
      "-x", proxy,
      "-X", "PUT",
      "-H", `Content-Length: ${data.byteLength}`,
      "-H", "X-Goog-Upload-Offset: 0",
      "-H", "X-Goog-Upload-Command: upload, finalize",
      "--data-binary", `@${tmpBody}`,
      uploadUrl,
    ], { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });

    const body = JSON.parse(output) as { file?: { name?: string } };
    const fileName = body.file?.name;
    if (!fileName) throw new Error("No file name in curl upload response");
    return fileName;
  } finally {
    try { require("fs").unlinkSync(tmpHeader); } catch {}
    try { require("fs").unlinkSync(tmpBody); } catch {}
  }
}
