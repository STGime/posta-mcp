/**
 * PostaClient — thin wrapper over the Posta REST API (https://api.getposta.app/v1).
 *
 * Auth: a single `posta_`-prefixed API token sent as `Authorization: Bearer <token>`.
 * Every request goes through the same auth + plan-enforcement middleware as the
 * web app and the Posta skill, so plan limits apply identically here.
 */

const DEFAULT_BASE_URL = "https://api.getposta.app/v1";

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

    const res = await fetch(`${this.baseUrl}${path}`, init);
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
   * Mirrors the SSRF safeguards from the Posta skill: HTTPS only, no private/internal hosts.
   */
  async uploadFromUrl(
    url: string,
    mimeType?: string,
    filename?: string,
  ): Promise<{ mediaId: string; status: string }> {
    if (!/^https:\/\//i.test(url)) {
      throw new Error(`Only HTTPS URLs are allowed (got: ${url}).`);
    }
    const host = new URL(url).hostname;
    if (isPrivateHost(host)) {
      throw new Error(
        `URLs pointing to private/internal networks are not allowed (host: ${host}).`,
      );
    }

    const download = await fetch(url);
    if (!download.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${download.status}`);
    }
    const bytes = new Uint8Array(await download.arrayBuffer());
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
    const put = await fetch(created.upload_url, {
      method: "PUT",
      headers: { "Content-Type": resolvedMime },
      body: bytes,
    });
    if (!put.ok) {
      throw new Error(`Upload to storage failed: HTTP ${put.status}`);
    }

    // Step 3: confirm — kicks off processing/variants.
    const confirmed = await this.post<{ media?: { id: string; status?: string } }>(
      `/media/${created.media_id}/confirm-upload`,
    );

    return {
      mediaId: confirmed?.media?.id || created.media_id,
      status: confirmed?.media?.status || "pending",
    };
  }
}

function isPrivateHost(host: string): boolean {
  return (
    /^(localhost|metadata\.google\.internal)$/i.test(host) ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^0\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
    /^169\.254\./.test(host) || // link-local / cloud metadata
    host === "::1"
  );
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

function guessFilename(url: string, mime: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop();
    if (last && /\.[a-z0-9]{2,4}$/i.test(last)) return last;
  } catch {
    /* fall through */
  }
  return `media${MIME_EXT[mime] || ""}`;
}
