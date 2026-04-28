import { execFileSync } from "child_process";

export const CONNECT_TIMEOUT = 30_000;
export const TOTAL_TIMEOUT = 300_000;

export function detectProxy(
  env: Record<string, string | undefined>,
): string | null {
  return env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.ALL_PROXY ?? null;
}

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

export async function httpPost(
  url: string,
  body: unknown,
  apiKey: string,
): Promise<HttpResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlPost(url, body, apiKey, proxy);
  }
  return fetchPost(url, body, apiKey);
}

async function fetchPost(
  url: string,
  body: unknown,
  apiKey: string,
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` } };
      // Treat non-JSON as server error regardless of original status
      return { status: 502, data };
    }
    return { status: res.status, data };
  } catch (err) {
    // Network/timeout errors — return as 503 so retry logic can handle them
    return { status: 503, data: { error: { message: `Network error: ${(err as Error).message}` } } };
  } finally {
    clearTimeout(timeout);
  }
}

function curlPost(
  url: string,
  body: unknown,
  apiKey: string,
  proxy: string,
): HttpResponse {
  const args = [
    "-s",
    "--connect-timeout",
    String(CONNECT_TIMEOUT / 1000),
    "--max-time",
    String(TOTAL_TIMEOUT / 1000),
    "-x",
    proxy,
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json",
    "-H",
    `x-goog-api-key: ${apiKey}`,
    "-d",
    JSON.stringify(body),
    "-w",
    "\n%{http_code}",
    url,
  ];
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

export async function httpPostWithRetry(
  url: string,
  body: unknown,
  apiKey: string,
): Promise<HttpResponse> {
  return withRetry(() => httpPost(url, body, apiKey));
}

export async function httpGetWithRetry(
  url: string,
  apiKey: string,
): Promise<HttpResponse> {
  return withRetry(() => httpGet(url, apiKey));
}

export interface HttpTextResponse {
  status: number;
  text: string;
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

export async function httpGet(
  url: string,
  apiKey: string,
): Promise<HttpResponse> {
  const proxy = detectProxy(process.env as Record<string, string>);
  if (proxy) {
    return curlGet(url, apiKey, proxy);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: buildHeaders(apiKey),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` } };
      // Treat non-JSON as server error regardless of original status
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
  apiKey: string,
  proxy: string,
): HttpResponse {
  const args = [
    "-s",
    "--connect-timeout",
    String(CONNECT_TIMEOUT / 1000),
    "--max-time",
    String(TOTAL_TIMEOUT / 1000),
    "-x",
    proxy,
    "-H",
    `x-goog-api-key: ${apiKey}`,
    "-w",
    "\n%{http_code}",
    url,
  ];
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
