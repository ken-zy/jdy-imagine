import { execFileSync } from "child_process";

export const CONNECT_TIMEOUT = 30_000;
export const TOTAL_TIMEOUT = 300_000;

export function detectProxy(
  env: Record<string, string | undefined>,
): string | null {
  return env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.ALL_PROXY ?? null;
}

/**
 * Legacy helper retained for backward compatibility (used by tests and any
 * external callers that built Google headers via this function before the
 * headers map refactor). New code should construct headers directly.
 */
export function buildHeaders(
  apiKey: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
}

export interface HttpResponse {
  status: number;
  data: unknown;
}

export interface HttpTextResponse {
  status: number;
  text: string;
}

export const RETRY_DELAYS_HTTP = [1000, 2000, 4000];
export const RETRYABLE_HTTP = new Set([429, 500, 503]);

async function withRetry(
  fn: () => Promise<HttpResponse>,
): Promise<HttpResponse> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_HTTP.length; attempt++) {
    const res = await fn();
    if (!RETRYABLE_HTTP.has(res.status) || attempt === RETRY_DELAYS_HTTP.length) {
      return res;
    }
    await Bun.sleep(RETRY_DELAYS_HTTP[attempt]);
  }
  throw new Error("Unreachable");
}

export async function httpPost(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlPost(url, body, headers, proxy);
  }
  return fetchPost(url, body, headers);
}

async function fetchPost(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  const fullHeaders = { "Content-Type": "application/json", ...headers };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: fullHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` } };
      return { status: 502, data };
    }
    return { status: res.status, data };
  } catch (err) {
    return { status: 503, data: { error: { message: `Network error: ${(err as Error).message}` } } };
  } finally {
    clearTimeout(timeout);
  }
}

function curlPost(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  proxy: string,
): HttpResponse {
  const args = [
    "-s",
    "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
    "--max-time", String(TOTAL_TIMEOUT / 1000),
    "-x", proxy,
    "-X", "POST",
    "-H", "Content-Type: application/json",
  ];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push("-d", JSON.stringify(body), "-w", "\n%{http_code}", url);
  try {
    const output = execFileSync("curl", args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = output.trimEnd().split("\n");
    const statusCode = parseInt(lines.pop()!, 10);
    const text = lines.join("\n");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: `Non-JSON response (${statusCode}): ${text.slice(0, 200)}` } };
      return { status: 502, data };
    }
    return { status: statusCode, data };
  } catch (err) {
    return { status: 503, data: { error: { message: `curl error: ${(err as Error).message}` } } };
  }
}

export async function httpPostWithRetry(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  return withRetry(() => httpPost(url, body, headers));
}

export async function httpGet(
  url: string,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlGet(url, headers, proxy);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` } };
      return { status: 502, data };
    }
    return { status: res.status, data };
  } catch (err) {
    return { status: 503, data: { error: { message: `Network error: ${(err as Error).message}` } } };
  } finally {
    clearTimeout(timeout);
  }
}

function curlGet(
  url: string,
  headers: Record<string, string>,
  proxy: string,
): HttpResponse {
  const args = [
    "-s",
    "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
    "--max-time", String(TOTAL_TIMEOUT / 1000),
    "-x", proxy,
  ];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push("-w", "\n%{http_code}", url);
  try {
    const output = execFileSync("curl", args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = output.trimEnd().split("\n");
    const statusCode = parseInt(lines.pop()!, 10);
    const text = lines.join("\n");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: `Non-JSON response (${statusCode}): ${text.slice(0, 200)}` } };
      return { status: 502, data };
    }
    return { status: statusCode, data };
  } catch (err) {
    return { status: 503, data: { error: { message: `curl error: ${(err as Error).message}` } } };
  }
}

export async function httpGetWithRetry(
  url: string,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  return withRetry(() => httpGet(url, headers));
}

export async function httpGetText(
  url: string,
  headers: Record<string, string>,
): Promise<HttpTextResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlGetText(url, headers, proxy);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    return { status: 503, text: `Network error: ${(err as Error).message}` };
  } finally {
    clearTimeout(timeout);
  }
}

function curlGetText(
  url: string,
  headers: Record<string, string>,
  proxy: string,
): HttpTextResponse {
  const args = [
    "-s",
    "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
    "--max-time", String(TOTAL_TIMEOUT / 1000),
    "-x", proxy,
    "-w", "\n%{http_code}",
  ];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push(url);
  try {
    const output = execFileSync("curl", args, {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = output.trimEnd().split("\n");
    const statusCode = parseInt(lines.pop()!, 10);
    return { status: statusCode, text: lines.join("\n") };
  } catch (err) {
    return { status: 503, text: `curl error: ${(err as Error).message}` };
  }
}

export interface HttpBytesResponse {
  status: number;
  bytes?: Uint8Array;
  error?: string;
}

/**
 * Raw binary GET. Mirrors httpGetText's proxy/curl branch but returns Uint8Array
 * instead of parsed JSON or text. Used for downloading rendered images from
 * apimart's task-result URLs without forcing them through JSON.parse.
 *
 * Status semantics:
 *   200      → bytes populated
 *   non-200  → error populated with response body (truncated)
 *   0        → network/curl failure; error populated with the underlying message
 */
export async function httpGetBytes(
  url: string,
  headers: Record<string, string> = {},
): Promise<HttpBytesResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlGetBytes(url, headers, proxy);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { status: res.status, error: body.slice(0, 500) };
    }
    const buf = await res.arrayBuffer();
    return { status: res.status, bytes: new Uint8Array(buf) };
  } catch (err) {
    return { status: 0, error: `Network error: ${(err as Error).message}` };
  } finally {
    clearTimeout(timeout);
  }
}

function curlGetBytes(
  url: string,
  headers: Record<string, string>,
  proxy: string,
): HttpBytesResponse {
  const args = [
    "-s",
    "--connect-timeout", String(CONNECT_TIMEOUT / 1000),
    "--max-time", String(TOTAL_TIMEOUT / 1000),
    "-x", proxy,
    "-w", "\n%{http_code}",
  ];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push(url);
  try {
    // Bun's execFileSync returns a Buffer when no encoding is set.
    const output = execFileSync("curl", args, {
      maxBuffer: 50 * 1024 * 1024,
    });
    const buf = Buffer.from(output);
    // The trailer "\n<status>" is appended in ASCII; locate the last newline before the
    // status code and split on that boundary so the binary body is preserved verbatim.
    let end = buf.length;
    while (end > 0 && buf[end - 1] !== 0x0a) end--;
    const statusStart = end;
    const status = parseInt(buf.slice(statusStart).toString("ascii"), 10);
    // Drop the trailing newline that precedes the status line.
    const bodyEnd = statusStart > 0 ? statusStart - 1 : 0;
    const body = buf.slice(0, bodyEnd);
    if (status >= 200 && status < 300) {
      return { status, bytes: new Uint8Array(body) };
    }
    return { status, error: body.toString("utf-8").slice(0, 500) };
  } catch (err) {
    return { status: 0, error: `curl error: ${(err as Error).message}` };
  }
}

export async function httpPostMultipart(
  url: string,
  formData: FormData,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return { status: 503, data: { error: { message: "Multipart upload not supported through HTTP proxy" } } };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: formData,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` } };
      return { status: 502, data };
    }
    return { status: res.status, data };
  } catch (err) {
    return { status: 503, data: { error: { message: `Network error: ${(err as Error).message}` } } };
  } finally {
    clearTimeout(timeout);
  }
}

export async function httpPostMultipartWithRetry(
  url: string,
  formData: FormData,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_HTTP.length; attempt++) {
    const res = await httpPostMultipart(url, formData, headers);
    if (!RETRYABLE_HTTP.has(res.status) || attempt === RETRY_DELAYS_HTTP.length) {
      return res;
    }
    await Bun.sleep(RETRY_DELAYS_HTTP[attempt]);
  }
  throw new Error("Unreachable");
}

export async function httpGetTextWithRetry(
  url: string,
  headers: Record<string, string>,
): Promise<HttpTextResponse> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_HTTP.length; attempt++) {
    const res = await httpGetText(url, headers);
    if (!RETRYABLE_HTTP.has(res.status) || attempt === RETRY_DELAYS_HTTP.length) {
      return res;
    }
    await Bun.sleep(RETRY_DELAYS_HTTP[attempt]);
  }
  throw new Error("Unreachable");
}
