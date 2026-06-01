# posta-mcp

An [MCP](https://modelcontextprotocol.io) server for **[Posta](https://getposta.app)** — schedule and publish to multiple social platforms (Instagram, TikTok, LinkedIn, YouTube, Pinterest, Bluesky, X, Facebook) from any MCP client.

Where the [Posta skill](https://clawhub.ai/stgime/posta) works inside Claude Code / OpenClaw, this MCP server works in the broader MCP ecosystem: **Claude Desktop, Claude web (remote MCP), Cursor, Windsurf, VS Code, Zed**, and anything that speaks MCP. It wraps the same Posta REST API and the same `posta_` token auth, so plan limits and behaviour are identical.

## Prerequisites

- Node.js ≥ 18
- A Posta account and an API token (Posta dashboard → **Settings → API tokens**). Tokens start with `posta_`.

## Install & build

```bash
npm install
npm run build
```

## Configure your MCP client

Add the server to your client's MCP config. Example (Claude Desktop — `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "posta": {
      "command": "node",
      "args": ["/absolute/path/to/posta-mcp/dist/index.js"],
      "env": {
        "POSTA_API_TOKEN": "posta_your_token_here"
      }
    }
  }
}
```

Once published to npm you can use `npx` instead of an absolute path:

```json
{
  "mcpServers": {
    "posta": {
      "command": "npx",
      "args": ["-y", "posta-mcp"],
      "env": { "POSTA_API_TOKEN": "posta_your_token_here" }
    }
  }
}
```

Cursor, Windsurf, VS Code (Cline/Continue), and Zed use the same `command`/`args`/`env` shape in their respective MCP settings.

### Environment

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `POSTA_API_TOKEN` | yes | — | Your `posta_` API token. |
| `POSTA_BASE_URL` | no | `https://api.getposta.app/v1` | Override the API base URL (e.g. staging). |

## Tools

All tools are namespaced `posta_*` and map 1:1 to the Posta REST API.

| Tool | What it does |
| --- | --- |
| `posta_list_accounts` | List connected social accounts (ids used when posting). |
| `posta_get_pinterest_boards` | List Pinterest boards for an account. |
| `posta_list_posts` | List posts, filterable by status. |
| `posta_get_post` | Get one post + per-platform results. |
| `posta_create_post` | Create a post (draft by default). |
| `posta_update_post` | Patch fields on an existing post. |
| `posta_schedule_post` | Schedule a post for an ISO-8601 time. |
| `posta_publish_post` | Publish a post immediately. |
| `posta_cancel_post` | Cancel a scheduled post. |
| `posta_delete_post` | Delete a post. |
| `posta_get_calendar` | Calendar view for a date range. |
| `posta_upload_from_url` | Add a public HTTPS image/video to the media library. |
| `posta_list_media` | List media assets. |
| `posta_get_media` | Get one media asset. |
| `posta_delete_media` | Delete a media asset. |
| `posta_generate_carousel_pdf` | Build a PDF carousel from images. |
| `posta_get_platform_specs` | Specs for all platforms (limits, media rules). |
| `posta_get_platform` | Specs for one platform. |
| `posta_get_aspect_ratios` | Supported aspect ratios per platform. |
| `posta_get_plan` | Current plan, limits, and usage. |
| `posta_get_analytics_overview` | Aggregate analytics for a period. |
| `posta_get_analytics_posts` | Per-post analytics, ranked. |
| `posta_get_best_times` | Best times to post. |
| `posta_compare_posts` | Compare 2–4 posts. |
| `posta_get_benchmarks` | Engagement benchmarks (Professional). |

## Typical flow

1. `posta_get_platform_specs` — check limits for your target platforms.
2. `posta_list_accounts` — get the account ids to post to.
3. `posta_upload_from_url` — add any media; keep the returned `mediaId`.
4. `posta_create_post` — caption + `socialAccountIds` + `mediaIds`.
   - TikTok needs `platformConfigurations.tiktok.privacyLevel`.
   - Pinterest needs `platformConfigurations.pinterest.boardId`.
5. `posta_schedule_post` (future) or `posta_publish_post` (now).

## Notes

- **Plan enforcement** is server-side. Tool calls go through the same middleware as the web app; exceeding a plan limit returns an API error surfaced as a tool error.
- **Security:** `posta_upload_from_url` accepts HTTPS URLs only and blocks private/internal hosts (SSRF guard).
- The token is read from `POSTA_API_TOKEN` only — it is never logged. Protocol traffic uses stdout; all diagnostics go to stderr.

## Roadmap

- **Remote (hosted) MCP** at `mcp.getposta.app` over Streamable HTTP with OAuth, so users connect from Claude Desktop/web without managing a local token.
- Generate the tool surface from the Posta OpenAPI spec so the skill, the n8n node, and this server never drift.

## License

MIT
