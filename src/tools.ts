/**
 * Tool registry for the Posta MCP server.
 *
 * Each tool maps 1:1 to a Posta REST endpoint — the same surface the Posta skill
 * (`posta-api.sh`) wraps — so the skill and this server stay behaviourally identical.
 * Tools are namespaced with the `posta_` prefix to avoid collisions with other MCP servers.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PostaClient, PostaApiError } from "./client.js";

/**
 * Render any value as a pretty-printed JSON text result.
 *
 * Important: the Posta API returns 204 No Content / empty bodies for
 * destructive endpoints (DELETE, cancel) and a few others. In those cases
 * `client.request()` resolves with `undefined`. JSON.stringify(undefined) is
 * itself `undefined` (NOT the string "undefined"), which produces
 * `content: [{ type: "text", text: undefined }]` and fails MCP's schema
 * validation on the client side ("expected string, received undefined").
 *
 * Treat `undefined`/`null` as a generic success and emit a minimal JSON ack
 * so every tool returns a schema-valid content block, regardless of the
 * upstream HTTP body.
 */
export function ok(value: unknown) {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value === undefined || value === null) {
    text = JSON.stringify({ ok: true });
  } else {
    text = JSON.stringify(value, null, 2);
  }
  return { content: [{ type: "text" as const, text }] };
}

/** Wrap a handler so API errors are returned as MCP tool errors, not thrown. */
function guard<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      const message =
        err instanceof PostaApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: `Error: ${message}` }],
      };
    }
  };
}

/** Encode a value for safe interpolation into a URL path segment. */
const enc = (v: string | number) => encodeURIComponent(String(v));

export function qs(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

export function registerTools(server: McpServer, client: PostaClient): void {
  // ── Accounts ────────────────────────────────────────────────────────────
  server.registerTool(
    "posta_list_accounts",
    {
      title: "List connected social accounts",
      description:
        "List the user's connected social accounts (platform, handle, id). Use the returned ids in `socialAccountIds` when creating posts.",
      inputSchema: {},
    },
    guard(async () => {
      const data = await client.get<{ accounts?: unknown }>("/social-accounts");
      return data?.accounts ?? data;
    }),
  );

  server.registerTool(
    "posta_get_pinterest_boards",
    {
      title: "List Pinterest boards",
      description:
        "List Pinterest boards for a connected Pinterest account. Pinterest posts require a boardId in platformConfigurations.",
      inputSchema: { accountId: z.string().describe("Connected Pinterest social account id") },
    },
    guard(({ accountId }) => client.get(`/social-accounts/${enc(accountId)}/boards`)),
  );

  // ── Posts ───────────────────────────────────────────────────────────────
  server.registerTool(
    "posta_list_posts",
    {
      title: "List posts",
      description:
        "List posts, optionally filtered by status (scheduled, posted, draft, failed, cancelled).",
      inputSchema: {
        status: z
          .enum(["scheduled", "posted", "draft", "failed", "cancelled"])
          .optional(),
        limit: z.number().int().min(1).max(100).optional().default(20),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    guard(({ status, limit, offset }) =>
      client.get(`/posts${qs({ status, limit, offset })}`),
    ),
  );

  server.registerTool(
    "posta_get_post",
    {
      title: "Get a post",
      description: "Get a single post by id, including its per-platform results.",
      inputSchema: { postId: z.string() },
    },
    guard(({ postId }) => client.get(`/posts/${enc(postId)}`)),
  );

  server.registerTool(
    "posta_create_post",
    {
      title: "Create a post",
      description:
        "Create a post (draft by default). Targets one or more connected accounts via socialAccountIds. " +
        "TikTok requires platformConfigurations.tiktok.privacyLevel; Pinterest requires platformConfigurations.pinterest.boardId. " +
        "Returns the created post with its id — then schedule or publish it.",
      inputSchema: {
        caption: z.string().describe("Post text/caption"),
        socialAccountIds: z
          .array(z.union([z.string(), z.number()]))
          .describe("Target connected-account ids (from posta_list_accounts)"),
        mediaIds: z
          .array(z.string())
          .optional()
          .describe("Media ids from posta_upload_from_url / posta_list_media"),
        hashtags: z.array(z.string()).optional(),
        isDraft: z
          .boolean()
          .optional()
          .default(true)
          .describe("Create as draft (true) or ready-to-schedule (false)"),
        platformConfigurations: z
          .record(z.any())
          .optional()
          .describe(
            'Per-platform overrides, e.g. { "tiktok": { "privacyLevel": "PUBLIC_TO_EVERYONE" }, "pinterest": { "boardId": "..." } }',
          ),
      },
    },
    guard((args) => client.post("/posts", args)),
  );

  server.registerTool(
    "posta_update_post",
    {
      title: "Update a post",
      description: "Patch fields on an existing post (e.g. caption, mediaIds, hashtags).",
      inputSchema: {
        postId: z.string(),
        patch: z.record(z.any()).describe("Partial post fields to update"),
      },
    },
    guard(({ postId, patch }) => client.patch(`/posts/${enc(postId)}`, patch)),
  );

  server.registerTool(
    "posta_schedule_post",
    {
      title: "Schedule a post",
      description:
        "Schedule a post for future publishing. scheduledAt must be an ISO-8601 timestamp (UTC recommended, e.g. 2026-06-01T14:30:00Z).",
      inputSchema: {
        postId: z.string(),
        scheduledAt: z.string().describe("ISO-8601 timestamp, e.g. 2026-06-01T14:30:00Z"),
      },
    },
    guard(({ postId, scheduledAt }) =>
      client.post(`/posts/${enc(postId)}/schedule`, { scheduledAt }),
    ),
  );

  server.registerTool(
    "posta_publish_post",
    {
      title: "Publish a post now",
      description: "Publish a post immediately to all of its target platforms.",
      inputSchema: { postId: z.string() },
    },
    guard(({ postId }) => client.post(`/posts/${enc(postId)}/publish`)),
  );

  server.registerTool(
    "posta_cancel_post",
    {
      title: "Cancel a scheduled post",
      description: "Cancel a scheduled post so it will not be published.",
      inputSchema: { postId: z.string() },
    },
    // Cancel endpoint returns an empty body. Surface { cancelled, id } so the
    // LLM has useful context to feed back to the user.
    guard(async ({ postId }) => {
      await client.post(`/posts/${enc(postId)}/cancel`);
      return { cancelled: true, id: postId };
    }),
  );

  server.registerTool(
    "posta_delete_post",
    {
      title: "Delete a post",
      description: "Permanently delete a post.",
      inputSchema: { postId: z.string() },
    },
    // DELETE returns 204 No Content. Echo the id back so the tool result is
    // informative; also avoids the empty-body content-validation crash on
    // older MCP SDKs that don't tolerate undefined text fields.
    guard(async ({ postId }) => {
      await client.delete(`/posts/${enc(postId)}`);
      return { deleted: true, id: postId };
    }),
  );

  server.registerTool(
    "posta_get_calendar",
    {
      title: "Get the content calendar",
      description: "Get a calendar view of posts in a date range (YYYY-MM-DD).",
      inputSchema: {
        start: z.string().describe("Start date, YYYY-MM-DD"),
        end: z.string().describe("End date, YYYY-MM-DD"),
      },
    },
    guard(({ start, end }) => client.get(`/posts/calendar${qs({ start, end })}`)),
  );

  // ── Media ───────────────────────────────────────────────────────────────
  server.registerTool(
    "posta_upload_from_url",
    {
      title: "Upload media from a URL",
      description:
        "Download a public HTTPS image/video and add it to the Posta media library. Returns a mediaId to use in posta_create_post. HTTPS only; private/internal hosts are blocked.",
      inputSchema: {
        url: z.string().describe("Public HTTPS URL of the image/video"),
        mimeType: z
          .string()
          .optional()
          .describe("Override MIME type, e.g. image/jpeg, video/mp4"),
        filename: z.string().optional(),
      },
    },
    guard(({ url, mimeType, filename }) =>
      client.uploadFromUrl(url, mimeType, filename),
    ),
  );

  server.registerTool(
    "posta_list_media",
    {
      title: "List media library",
      description: "List media assets, optionally filtered by type and processing status.",
      inputSchema: {
        type: z.enum(["image", "video"]).optional(),
        status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
        limit: z.number().int().min(1).max(100).optional().default(20),
        offset: z.number().int().min(0).optional().default(0),
      },
    },
    guard(({ type, status, limit, offset }) =>
      client.get(`/media${qs({ type, status, limit, offset })}`),
    ),
  );

  server.registerTool(
    "posta_get_media",
    {
      title: "Get a media asset",
      description: "Get a single media asset by id (status, variants, URLs).",
      inputSchema: { mediaId: z.string() },
    },
    guard(({ mediaId }) => client.get(`/media/${enc(mediaId)}`)),
  );

  server.registerTool(
    "posta_delete_media",
    {
      title: "Delete a media asset",
      description: "Delete a media asset from the library.",
      inputSchema: { mediaId: z.string() },
    },
    // DELETE returns 204 No Content — same handling as posta_delete_post.
    guard(async ({ mediaId }) => {
      await client.delete(`/media/${enc(mediaId)}`);
      return { deleted: true, id: mediaId };
    }),
  );

  server.registerTool(
    "posta_generate_carousel_pdf",
    {
      title: "Generate a carousel PDF",
      description: "Generate a PDF carousel from multiple image media ids (e.g. for LinkedIn document posts).",
      inputSchema: {
        mediaIds: z.array(z.string()).min(1),
        title: z.string().optional(),
      },
    },
    guard(({ mediaIds, title }) =>
      client.post("/media/generate-carousel-pdf", {
        media_ids: mediaIds,
        ...(title ? { title } : {}),
      }),
    ),
  );

  // ── Platform discovery ──────────────────────────────────────────────────
  server.registerTool(
    "posta_get_platform_specs",
    {
      title: "Get all platform specifications",
      description:
        "Get specs for every supported platform: character limits, media requirements, supported features. Consult before creating posts.",
      inputSchema: {},
    },
    guard(() => client.get("/platforms/specifications")),
  );

  server.registerTool(
    "posta_get_platform",
    {
      title: "Get one platform's specification",
      description: "Get detailed specs for a single platform (e.g. instagram, tiktok, bluesky, linkedin, x).",
      inputSchema: { platform: z.string() },
    },
    guard(({ platform }) => client.get(`/platforms/${enc(platform)}`)),
  );

  server.registerTool(
    "posta_get_aspect_ratios",
    {
      title: "Get supported aspect ratios",
      description: "Get the image/video aspect ratios supported per platform.",
      inputSchema: {},
    },
    guard(() => client.get("/platforms/aspect-ratios")),
  );

  // ── Account / plan ──────────────────────────────────────────────────────
  server.registerTool(
    "posta_get_plan",
    {
      title: "Get current plan & limits",
      description: "Get the user's current plan, limits, and usage (accounts, networks per post, webhooks, etc.).",
      inputSchema: {},
    },
    guard(() => client.get("/users/plan")),
  );

  // ── Analytics ───────────────────────────────────────────────────────────
  server.registerTool(
    "posta_get_analytics_overview",
    {
      title: "Analytics overview",
      description: "Aggregate analytics overview for a period (e.g. 7d, 30d, 90d).",
      inputSchema: { period: z.string().optional().default("30d") },
    },
    guard(({ period }) => client.get(`/analytics/overview${qs({ period })}`)),
  );

  server.registerTool(
    "posta_get_analytics_posts",
    {
      title: "Per-post analytics",
      description: "List posts ranked by an engagement metric, with their analytics.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().default(20),
        offset: z.number().int().min(0).optional().default(0),
        sortBy: z.string().optional().default("engagements"),
        sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
        socialAccountIds: z
          .string()
          .optional()
          .describe("Comma-separated account ids to filter by"),
      },
    },
    guard(({ limit, offset, sortBy, sortOrder, socialAccountIds }) =>
      client.get(`/analytics/posts${qs({ limit, offset, sortBy, sortOrder, socialAccountIds })}`),
    ),
  );

  server.registerTool(
    "posta_get_best_times",
    {
      title: "Best times to post",
      description: "Get recommended best times to post based on the account's historical engagement.",
      inputSchema: {},
    },
    guard(() => client.get("/analytics/best-times")),
  );

  server.registerTool(
    "posta_compare_posts",
    {
      title: "Compare posts",
      description: "Compare 2–4 posts side by side by their analytics.",
      inputSchema: {
        postIds: z
          .string()
          .describe("Comma-separated post ids, e.g. 'id1,id2,id3'")
          .refine(
            (s) => {
              const n = s.split(",").filter((p) => p.trim() !== "").length;
              return n >= 2 && n <= 4;
            },
            { message: "Provide between 2 and 4 comma-separated post ids." },
          ),
      },
    },
    guard(({ postIds }) => client.get(`/analytics/compare${qs({ postIds })}`)),
  );

  server.registerTool(
    "posta_get_benchmarks",
    {
      title: "Engagement benchmarks",
      description: "Get engagement benchmarks per platform (Professional plan feature).",
      inputSchema: {},
    },
    guard(() => client.get("/analytics/benchmarks")),
  );
}
