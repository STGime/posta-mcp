/**
 * PostaClient — thin wrapper over the Posta REST API (https://api.getposta.app/v1).
 *
 * Auth: a single `posta_`-prefixed API token sent as `Authorization: Bearer <token>`.
 * Every request goes through the same auth + plan-enforcement middleware as the
 * web app and the Posta skill, so plan limits apply identically here.
 */

import { lookup } from "node:dns/promises";

const DEFAULT_BASE_URL = "https://api.getposta.app/v1";

/** Time budgets for outbound requests (ms). */
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Hard ceiling on a downloaded media file, to avoid buffering unbounded bytes into memory. */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

/** Max redirect hops to follow while fetching a remote media URL (each hop is re-validated). */
const MAX_REDIRECTS = 5;

export class PostaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly body: string,
  ) {
    super(`Posta API ${status} on ${endpoint}: ${body}`);
    this.name = "PostaApiError";
  }
}

export interface PostaClientOptions {
  token: string;
  baseUrl?: string;
}

export class PostaClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor({ token, baseUrl }: PostaClientOptions) {
    if (!token) {
      throw new Error(
        "POSTA_API_TOKEN is required. Generate one in the Posta dashboard and set it in your MCP server config.",
      );
    }
    this.token = token;
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  /** Generic JSON request against the Posta API. `path` must start with "/". */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      init,
      API_TIMEOUT_MS,
    );
    const text = await res.text();

    if (!res.ok) {
      if (res.status === 401) {
        throw new PostaApiError(
          401,
          path,
          "API token is invalid or revoked. Generate a new one in the Posta dashboard.",
        );
      }
      throw new PostaApiError(res.status, path, text || res.statusText);
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Non-JSON responses (e.g. CSV/PDF export endpoints) are returned raw.
      return text as unknown as T;
    }
  }

  get<T = unknown>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }
  patch<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  delete<T = unknown>(path: string) {
    return this.request<T>("DELETE", path);
  }

  /**
   * Download a remote (HTTPS) asset and upload it to Posta's media library via the
   * 3-step signed-URL flow: create-upload-url → PUT to storage → confirm-upload.
   * Returns the created media id (use it in `mediaIds` when creating a post).
   *
   * SSRF safeguards: HTTPS only; the host is resolved and every resolved IP is
   * checked against private/internal ranges; redirects are followed manually and
   * each hop is re-validated; the download is capped at MAX_DOWNLOAD_BYTES.
   */
  async uploadFromUrl(
    url: string,
    mimeType?: string,
    filename?: string,
  ): Promise<{ mediaId: string; status: string }> {
    const download = await safeFetchPublic(url, DOWNLOAD_TIMEOUT_MS);
    if (!download.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${download.status}`);
    }

    // Reject early if the server declares an oversized body.
    const declared = Number(download.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `Remote file is ${declared} bytes, exceeding the ${MAX_DOWNLOAD_BYTES}-byte limit.`,
      );
    }

    // Read the body with a hard cap so a missing/lying Content-Length can't OOM us.
    const bytes = await readBodyWithLimit(download, MAX_DOWNLOAD_BYTES);

    const resolvedMime =
      mimeType || download.headers.get("content-type")?.split(";")[0]?.trim() || "";
    if (!resolvedMime) {
      throw new Error(
        "Could not determine MIME type. Pass `mimeType` explicitly (e.g. image/jpeg).",
      );
    }
    const name = filename || guessFilename(url, resolvedMime);

    // Step 1: reserve an upload slot.
    const created = await this.post<{ media_id: string; upload_url: string }>(
      "/media/create-upload-url",
      { name, mime_type: resolvedMime, size_bytes: bytes.byteLength },
    );
    if (!created?.media_id || !created?.upload_url) {
      throw new Error("create-upload-url did not return media_id/upload_url.");
    }

    // Step 2: PUT the bytes to the signed storage URL (no auth header — it's pre-signed).
    const put = await fetchWithTimeout(
      created.upload_url,
      {
        method: "PUT",
        headers: { "Content-Type": resolvedMime },
        body: bytes,
      },
      DOWNLOAD_TIMEOUT_MS,
    );
    if (!put.ok) {
      throw new Error(`Upload to storage failed: HTTP ${put.status}`);
    }

    // Step 3: confirm — kicks off processing/variants.
    const confirmed = await this.post<{ media?: { id: string; status?: string } }>(
      `/media/${encodeURIComponent(created.media_id)}/confirm-upload`,
    );

    return {
      mediaId: confirmed?.media?.id || created.media_id,
      status: confirmed?.media?.status || "pending",
    };
  }
}

/** Run `fetch` with an AbortController-backed timeout, surfacing a clear error on timeout. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a public HTTPS URL with SSRF protection: validate (and DNS-resolve) the
 * host on every hop, follow up to MAX_REDIRECTS redirects manually, and reject any
 * hop that resolves to a private/internal address.
 */
async function safeFetchPublic(
  rawUrl: string,
  timeoutMs: number,
): Promise<Response> {
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetchWithTimeout(url, { redirect: "manual" }, timeoutMs);

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      // Drain the redirect body and resolve the next URL relative to the current one.
      await res.body?.cancel();
      url = new URL(location, url).toString();
      continue;
    }
    return res;
  }
  throw new Error(
    `Too many redirects while fetching ${rawUrl} (max ${MAX_REDIRECTS}).`,
  );
}

/** Validate a single URL: HTTPS only, and no resolved IP in a private/internal range. */
async function assertPublicUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Only HTTPS URLs are allowed (got: ${rawUrl}).`);
  }
  const addresses = await resolveHost(parsed.hostname);
  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new Error(
        `Refusing to fetch ${parsed.hostname}: it resolves to a private/internal address (${addr}).`,
      );
    }
  }
}

/**
 * Resolve a hostname (or IP literal) to its addresses via the same path Node's
 * fetch uses to connect. Resolving here also normalises encoded IP literals
 * (decimal/hex/octal) to their real address so they can be range-checked.
 */
async function resolveHost(hostname: string): Promise<string[]> {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, ""); // strip IPv6 brackets
  try {
    const results = await lookup(host, { all: true });
    if (!results.length) throw new Error("no addresses");
    return results.map((r) => r.address);
  } catch {
    throw new Error(`Could not resolve host: ${hostname}`);
  }
}

/** True if an IPv4/IPv6 address is loopback, private, link-local, or otherwise non-public. */
export function isPrivateIp(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (ip.includes(":")) return isPrivateIpv6(ip);
  return isPrivateIpv4(ip);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  // Anything we can't parse cleanly is treated as unsafe.
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 || // "this" network / 0.0.0.0
    a === 127 || // loopback
    a === 10 || // private
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    a >= 224 // multicast (224/4) and reserved (240/4)
  );
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe80")) return true; // link-local
  return /^f[cd]/.test(lower); // unique local addresses fc00::/7
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
};

export function guessFilename(url: string, mime: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop();
    if (last && /\.[a-z0-9]{2,4}$/i.test(last)) return last;
  } catch {
    /* fall through */
  }
  return `media${MIME_EXT[mime] || ""}`;
}

/** Read a response body into memory, aborting if it exceeds `maxBytes`. */
async function readBodyWithLimit(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`Remote file exceeds the ${maxBytes}-byte limit.`);
    }
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Remote file exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
