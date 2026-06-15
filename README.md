# posta-mcp

An [MCP](https://modelcontextprotocol.io) server for **[Posta](https://getposta.app)** — schedule and publish to multiple social platforms (Instagram, TikTok, LinkedIn, YouTube, Pinterest, Bluesky, X, Facebook) from any MCP client.

Where the [Posta skill](https://clawhub.ai/stgime/posta) works inside Claude Code / OpenClaw, this MCP server works in the broader MCP ecosystem: **Claude Desktop, Claude web (remote MCP), Cursor, Windsurf, VS Code, Zed**, and anything that speaks MCP. It wraps the same Posta REST API and the same `posta_` token auth, so plan limits and behaviour are identical.

## Prerequisites

- Node.js ≥ 18
- A Posta account and an API token (Posta dashboard → **Settings → API tokens**). Tokens start with `posta_`.

## Install

`posta-mcp` is published on npm, so you don't clone or build anything — your MCP client downloads and runs it automatically with `npx`. Follow these five steps.

### Step 1 — Get your Posta API token

In the [Posta dashboard](https://getposta.app), go to **Settings → API tokens**, click **Create token**, and copy it. It starts with `posta_`. You only see it once, so copy it now.

### Step 2 — Open your MCP client's config file

For **Claude Desktop**, the file is `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

The easiest way to open it: in Claude Desktop go to **Settings → Developer → Edit Config**. If the file doesn't exist yet, create it.
(Using a different client? See [the table below](#config-location-per-client).)

### Step 3 — Add the Posta server

Paste this into the file, then replace `posta_your_token_here` with the token from Step 1:

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

If the file already has other servers under `"mcpServers"`, add the `"posta"` block next to them — don't create a second `"mcpServers"` key.

### Step 4 — Restart the client

**Fully quit and reopen** your MCP client (close the window is not enough — quit the app). The first launch downloads the package, so give it a few seconds.

### Step 5 — Verify it works

Start a new chat and ask: **"List my connected Posta accounts."** Claude should call the `posta_list_accounts` tool (approve it if prompted). If you see your accounts, you're done.

> **Windows:** if you get a "command not found" error, set `"command": "npx.cmd"` instead of `"npx"`, and make sure Node.js is installed (from [nodejs.org](https://nodejs.org)) so `npx` is on your PATH.

<a id="config-location-per-client"></a>
### Config location per client

Every client uses the **same `command` / `args` / `env` block** shown above — only the location differs:

| Client | Where the config lives |
| --- | --- |
| **Claude Desktop** | **Settings → Developer → Edit Config**, or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| **Cursor** | **Settings → MCP → Add new server**, or `~/.cursor/mcp.json` |
| **Windsurf** | **Settings → Cascade → MCP servers → Manage**, or `~/.codeium/windsurf/mcp_config.json` |
| **VS Code (Cline / Continue)** | the extension's MCP settings (Cline: **MCP Servers → Configure MCP Servers**) |
| **Zed** | `settings.json` → `"context_servers"` |

## Run from source (development only)

You only need this if you're modifying the server itself. Clone the repo, then:

```bash
npm install
npm run build
```

Then point your client at the built file with an absolute path instead of `npx`:

```json
{
  "mcpServers": {
    "posta": {
      "command": "node",
      "args": ["/absolute/path/to/posta-mcp/dist/index.js"],
      "env": { "POSTA_API_TOKEN": "posta_your_token_here" }
    }
  }
}
```

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `POSTA_API_TOKEN` | yes | — | Your `posta_` API token. |
| `POSTA_BASE_URL` | no | `https://api.getposta.app/v1` | Override the API base URL (e.g. staging). |

> The server reads these from the process environment provided by your MCP client — it does **not** auto-load a `.env` file. `.env.example` is a reference for the values you set in your client config. For local `npm run dev`, export the variable yourself (e.g. `POSTA_API_TOKEN=… npm run dev`) or use `node --env-file=.env dist/index.js` on Node ≥ 20.6.

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
- **Security:** `posta_upload_from_url` has an SSRF guard — HTTPS only; the host is DNS-resolved and every resolved IP is checked against private/internal/link-local ranges (IPv4 and IPv6, including cloud-metadata `169.254.169.254`); redirects are followed manually and re-validated on each hop; downloads are capped at 100 MB; and all outbound requests have timeouts.
- The token is read from `POSTA_API_TOKEN` only — it is never logged. Protocol traffic uses stdout; all diagnostics go to stderr.

## Roadmap

- **Remote (hosted) MCP** at `mcp.getposta.app` over Streamable HTTP with OAuth, so users connect from Claude Desktop/web without managing a local token.
- Generate the tool surface from the Posta OpenAPI spec so the skill, the n8n node, and this server never drift.

## License

MIT
