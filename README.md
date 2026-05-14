# github-router

[![CI](https://github.com/animeshkundu/github-router/actions/workflows/ci.yml/badge.svg)](https://github.com/animeshkundu/github-router/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/github-router)](https://www.npmjs.com/package/github-router)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Use your GitHub Copilot subscription to power **Claude Code**, **Codex CLI**, or any OpenAI/Anthropic-compatible tool.

github-router is a local reverse proxy that translates standard API formats to GitHub Copilot's backend. One command to start, copy-paste configs for your tools.

> [!WARNING]
> Unofficial. Not supported by GitHub. May break. Use responsibly.
> Review the [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot) and [Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github).

## Quick Start

```sh
# 1. Authenticate (one-time)
npx github-router@latest auth

# 2. Start the proxy
npx github-router@latest start
```

The server runs at `http://localhost:8787`. Now pick your tool below.

---

## Use with Claude Code

**Option A: One-shot subcommand (recommended)**

```sh
npx github-router@latest claude
```

Boots the proxy on a random port and spawns Claude Code wired to it. Sets `ANTHROPIC_MODEL=claude-opus-4-7` (Anthropic's dashed slug — Claude Code's `/model` UI displays this as menu entry "Opus 4.7 (1M context)"). The proxy translates to Copilot's `claude-opus-4.7-1m-internal` on enterprise tokens or `claude-opus-4.7` on Pro+/Business/Max at request time. Major.minor fallback chain: `claude-opus-4-6` → `claude-opus-4-5`. Override with `-m`:

```sh
npx github-router@latest claude -m claude-opus-4-7
```

The launcher sanitizes parent-env auth keys and sets `CLAUDE_CONFIG_DIR=$HOME/.claude` so the spawned `claude` ignores any persisted Console OAuth credential without requiring `claude /logout`. Settings, MCP servers, hooks, and CLAUDE.md auto-discovery still load from `~/.claude` as normal.

**Option B: Interactive launch-command generator**

```sh
npx github-router@latest start --claude-code
```

Select your models, a launch command gets copied to your clipboard. Paste it in a new terminal.

**Option C: Copy-paste config**

Create `.claude/settings.json` in your project:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8787",
    "ANTHROPIC_API_KEY": "dummy",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1-mini",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1-mini",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": ["WebSearch"]
  }
}
```

Then run `claude` as normal.

### Peer-MCP review subagents

`github-router claude` auto-wires four peer-model adversarial reviewers plus a coordinator into the spawned Claude Code session. No setup, no prior MCP config, no `.claude/agents/` files needed — they appear as Task `subagent_type` options the session can delegate to. Opt out with `--no-codex-mcp`.

Each persona is exposed both as a Claude Code subagent (callable via the `Task` tool) AND as an MCP tool at `mcp__gh-router-peers__<name>`. Personas are stateless: each invocation runs a fresh request against its model with a baked persona prompt — they have no access to your scrollback or project memory, so the lead must paste the artifact into the brief.

| Subagent | Model | Endpoint | Effort tiers (default) |
|---|---|---|---|
| `codex-critic` | gpt-5.5 | `/v1/responses` | low \| medium \| high \| xhigh (high) |
| `codex-reviewer` | gpt-5.3-codex | `/v1/responses` | low \| medium \| high \| xhigh (high) |
| `opus-critic` | claude-opus-4-7 | `/v1/messages` | low \| medium \| high \| xhigh (medium) |
| `gemini-critic` | gemini-3.1-pro-preview | `/v1/chat/completions` | low \| medium \| high \| xhigh (high) |
| `peer-review-coordinator` | (meta) | — | — |

`peer-review-coordinator` is a subagent (not an MCP tool) that fans out to the right combination of the four critics in parallel based on artifact type — plan, diff, single file, or long-context — and aggregates findings.

**Effort tiers** are exposed via the MCP tool's `effort` argument; subagents pass it through. All four tiers are accepted on every persona. `xhigh` routinely runs 60–90s; the proxy responds to `tools/call` requests with SSE-streamed responses (per MCP 2025-06-18 Streamable HTTP transport spec) so the connection stays open past the standard ~60s MCP per-tool-call ceiling and long calls complete transparently with no user setup.

`gemini-critic` only registers when `gemini-3.1-pro-preview` is present in your Copilot model catalog. If absent, the persona is silently dropped from both the MCP `tools/list` and the subagent set, and `peer-review-coordinator` skips it in routing decisions.

For codex-side write capability (a `codex-implementer` persona that can mutate files via Codex's tool-use sandbox), pass `--codex-cli`. Requires `codex` CLI 0.129+ on `PATH`; falls back to HTTP-only with a warning if codex is missing or older. Pass `--codex-mcp-only` to also pass `--strict-mcp-config` to Claude Code so only the proxy's MCP servers are loaded (hides any MCP servers in your existing `~/.claude/mcp.json`).

---

## Use with Codex CLI

The fastest path is the `codex` subcommand — it boots the proxy on a random port and spawns Codex CLI wired to it:

```sh
npx github-router@latest codex
```

Defaults to `gpt-5.5`; falls back to `gpt-5.4` → `gpt-5.3-codex` → `gpt-5.2-codex` if your Copilot tier doesn't expose 5.5 yet. Override with `-m`:

```sh
npx github-router@latest codex -m gpt-5.3-codex
```

Or run the proxy and Codex CLI separately:

```sh
npx github-router@latest start --codex   # interactive launch-command generator
# — or set env vars yourself —
export OPENAI_BASE_URL="http://localhost:8787/v1"
export OPENAI_API_KEY="dummy"
codex --full-auto -m gpt-5.5
```

---

## Use with any OpenAI-compatible tool

Point any tool at `http://localhost:8787/v1`:

```sh
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4.1", "messages": [{"role": "user", "content": "Hello"}]}'
```

---

## API Endpoints

| Endpoint | Method | Format |
|---|---|---|
| `/v1/chat/completions` | POST | OpenAI Chat Completions |
| `/v1/responses` | POST | OpenAI Responses (Codex models) |
| `/v1/messages` | POST | Anthropic Messages |
| `/v1/messages/count_tokens` | POST | Anthropic token counting |
| `/v1/models` | GET | OpenAI model list |
| `/v1/embeddings` | POST | OpenAI embeddings |
| `/v1/search` | POST | Web search |
| `/usage` | GET | Copilot usage & quotas |

OpenAI-compatible endpoints are also available without the `/v1` prefix (for example, `/chat/completions`).
Anthropic endpoints are only available under `/v1/messages`.

<details>
<summary>Model / endpoint compatibility</summary>

| Model | /chat/completions | /responses | /v1/messages |
|---|---|---|---|
| gpt-4.1, gpt-4o | Yes | Yes | No |
| gpt-5.5, gpt-5.4 | No | Yes | No |
| gpt-5.3-codex, gpt-5.2-codex | No | Yes | No |
| claude-opus-4.7-1m-internal (enterprise), claude-opus-4.7 | Yes | No | Yes |
| claude-opus-4.6-1m, claude-opus-4.6, claude-sonnet-4.6 | Yes | No | Yes |
| o3, o4-mini | Yes | Yes | No |

</details>

---

## Docker

Pre-built images on GitHub Container Registry:

```sh
docker pull ghcr.io/animeshkundu/github-router:latest
docker run -p 8787:8787 -e GH_TOKEN=your_token ghcr.io/animeshkundu/github-router
```

Or build locally:

```sh
docker build -t github-router .
docker run -p 8787:8787 -e GH_TOKEN=your_token github-router
```

<details>
<summary>Docker Compose</summary>

```yaml
services:
  github-router:
    build: .
    ports:
      - "8787:8787"
    environment:
      - GH_TOKEN=your_github_token_here
    restart: unless-stopped
```

</details>

<details>
<summary>Persistent token storage</summary>

```sh
mkdir -p ./github-router-data
docker run -p 8787:8787 -v $(pwd)/github-router-data:/root/.local/share/github-router github-router
```

</details>

---

## CLI Reference

```
github-router start [options]    Start the proxy server
github-router claude [options]   Start proxy + spawn Claude Code wired to it
github-router codex [options]    Start proxy + spawn Codex CLI wired to it
github-router auth               Authenticate with GitHub
github-router check-usage        Show Copilot usage/quotas
github-router debug              Print diagnostic info
```

The `claude` and `codex` subcommands accept all the shared flags below plus `-m`/`--model` to override the default model. Default models live in `src/lib/port.ts`:

- `claude` → `claude-opus-4-7` (Anthropic dashed slug for UI compatibility; the proxy translates to Copilot's `claude-opus-4.7-1m-internal` on enterprise or `claude-opus-4.7` elsewhere). Major.minor fallback chain: `claude-opus-4-6` → `claude-opus-4-5`.
- `codex` → `gpt-5.5` → `gpt-5.4` → `gpt-5.3-codex` → `gpt-5.2-codex`

Fallback chains fire only on the implicit-default path; explicit `-m`/`--model` is always respected as-is.

| Flag | Description | Default |
|---|---|---|
| `--port, -p` | Port | 8787 |
| `--verbose, -v` | Debug logging | false |
| `--account-type, -a` | `individual` / `business` / `enterprise` | individual |
| `--rate-limit, -r` | Min seconds between requests | - |
| `--wait, -w` | Queue requests instead of rejecting on rate limit | false |
| `--manual` | Approve each request manually | false |
| `--github-token, -g` | Pass token directly (skip auth flow) | - |
| `--claude-code, -c` | Generate Claude Code launch command | false |
| `--codex` | Generate Codex CLI launch command | false |
| `--show-token` | Print tokens to console | false |
| `--proxy-env` | Use HTTP_PROXY/HTTPS_PROXY env vars | false |

Additional flags accepted only by the `claude` subcommand:

| Flag | Description | Default |
|---|---|---|
| `--model, -m` | Override the default Claude model | claude-opus-4-7 |
| `--codex-mcp` / `--no-codex-mcp` | Wire peer-MCP review subagents (codex-critic / opus-critic / gemini-critic / codex-reviewer / peer-review-coordinator) into the spawned session | true |
| `--codex-cli` | Add a `codex mcp-server` stdio backend so `codex-implementer` can mutate files. Requires codex CLI 0.129+; falls back to HTTP-only if absent | false |
| `--codex-mcp-only` | Pass `--strict-mcp-config` to Claude Code so only the proxy's MCP servers load (hides any user MCP servers in `~/.claude/mcp.json`) | false |
| `--stealth` | Opt back into VS Code-only beta-header filtering. Loses leverage features (task budgets, token-efficient tools, prompt caching, etc.) but minimizes the wire-fingerprint diff from VS Code Copilot Chat | false |
| `--auto-update` / `--no-auto-update` | Check for and install latest Claude Code on launch (throttled to once per hour). Falls back gracefully if npm/network unavailable | true |
| `--update-check` / `--no-update-check` | Check the npm registry for a newer Claude Code version on launch and warn if stale (~500ms cost). `--no-update-check` implies no auto-install | true |

---

## Development

```sh
bun install          # Install deps
bun run dev          # Dev server with hot reload
bun test             # Run tests
bun run lint:all     # Lint
bun run typecheck    # Type check
bun run build        # Build for distribution
```

## License

[MIT](LICENSE)
