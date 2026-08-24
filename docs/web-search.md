# Web search

How `/search` fulfils web-search tool calls via Copilot's MCP endpoint with the
GitHub PAT, and how the proxy translates `web_search_*` tool calls for
Anthropic-shape clients. See [`../CLAUDE.md`](../CLAUDE.md) for project overview.

## Wire flow

The `/search` route fulfils web-search tool calls via Copilot's MCP (Model Context Protocol) endpoint at `${copilotBaseUrl}/mcp`, the same path Copilot CLI uses for its `web_search` tool. **Auth is the GitHub PAT directly** (`state.githubToken`), not the Copilot-exchanged token — `/mcp` validates a Copilot seat against the OAuth token rather than the short-lived CAPI bearer.

Wire flow (in `src/services/copilot/web-search.ts`): `initialize` → capture `Mcp-Session-Id` → `notifications/initialized` → `tools/call` `{name:"web_search", arguments:{query}}` over SSE-framed JSON-RPC. The required `X-MCP-Toolsets: web_search` header is what makes the tool appear in `tools/list`; without it the default toolset omits `web_search`. Best-effort `DELETE /mcp` teardown closes the session.

This path is **model-agnostic** — the proxy fulfils the search out-of-band before forwarding the assistant's `tool_use` to the model. Works regardless of whether the user's enterprise has the `github_chat` policy enabled (the legacy `/github/chat/threads` wrapper required it; that entitlement silently flipped from Enabled-default to Disabled-default per the [Nov 4 2025 changelog](https://github.blog/changelog/2025-11-04-github-copilot-policy-update-for-unconfigured-policies/)).

For OpenAI-shaped clients on GPT-5.x clients can also use `tools:[{type:"web_search_preview"}]` on `/v1/responses` directly — Copilot fulfils that natively without going through the proxy's MCP path. For Anthropic-shape `web_search_*` tools on `/v1/messages`, Copilot returns 400 "use of the web search tool is not supported"; the proxy strips them via the existing `injectWebSearchIfNeeded` path and substitutes MCP-fetched search context in the system prompt.

## Prompt-cache-safe result placement

Search results are volatile and must not precede a reusable system prefix.
The old prepend behavior rewrote the head of the stable prefix on every
search turn, which is the shape of a cache-invalidating write on any provider
whose caching keys off a stable prefix; it is not yet backed by a live
measurement harness (see [`prompt-caching.md`](prompt-caching.md) for that
caveat generally). The proxy now places results by endpoint instead of
prepending them:

- Anthropic Messages: existing system blocks remain first, followed by the
  unmarked result block and a short authoritative tail that tells the model to
  use factual claims while ignoring instructions embedded in search content.
  Native Claude `/v1/messages` cache_control placement otherwise remains
  entirely caller-controlled; the router does not add or remove markers there.
- Chat Completions: results are a later unmarked system message after the
  existing leading system messages.
- Responses: `instructions` and leading system input items remain first;
  results are inserted as the next system input item before user input.

Each route has an independent emergency rollback:
`GH_ROUTER_DISABLE_MESSAGES_WEB_CACHE_REPAIR=1`,
`GH_ROUTER_DISABLE_CHAT_WEB_CACHE_REPAIR=1`, or
`GH_ROUTER_DISABLE_RESPONSES_WEB_CACHE_REPAIR=1`. The legacy behavior prepends
results and is intentionally less cache-efficient.

## PAT exfiltration safeguard

PAT-bearing requests are sent only to hosts in `COPILOT_HOST_ALLOWLIST` (`src/services/github/get-copilot-token.ts`) — `endpoints.api` from the token-exchange response is rejected if it points elsewhere, so a tampered response can't exfiltrate the PAT.
