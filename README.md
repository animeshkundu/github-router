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

**Option A — Interactive (recommended)**

```sh
npx github-router@latest start --claude-code
```

Select your models, a launch command gets copied to your clipboard. Paste it in a new terminal.

**Option B — Copy-paste config**

Create `.claude/settings.json` in your project:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8787",
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

---

## Use with Codex CLI

```sh
npx github-router@latest start --codex
```

Or set the env vars yourself:

```sh
export OPENAI_BASE_URL="http://localhost:8787/v1"
export OPENAI_API_KEY="dummy"
codex -m gpt5.2-codex
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

All endpoints also available without the `/v1` prefix.

<details>
<summary>Model / endpoint compatibility</summary>

| Model | /chat/completions | /responses |
|---|---|---|
| gpt-4.1, gpt-4o | Yes | Yes |
| gpt5.2-codex, gpt-5.1-codex-mini | No | Yes |
| claude-sonnet-4, claude-opus-4 | Yes (via /messages) | No |
| o3, o4-mini | Yes | Yes |

</details>

---

## Docker

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
github-router auth               Authenticate with GitHub
github-router check-usage        Show Copilot usage/quotas
github-router debug              Print diagnostic info
```

| Flag | Description | Default |
|---|---|---|
| `--port, -p` | Port | 8787 |
| `--verbose, -v` | Debug logging | false |
| `--account-type, -a` | `individual` / `business` / `enterprise` | individual |
| `--rate-limit, -r` | Min seconds between requests | — |
| `--wait, -w` | Queue requests instead of rejecting on rate limit | false |
| `--manual` | Approve each request manually | false |
| `--github-token, -g` | Pass token directly (skip auth flow) | — |
| `--claude-code, -c` | Generate Claude Code launch command | false |
| `--codex` | Generate Codex CLI launch command | false |
| `--show-token` | Print tokens to console | false |
| `--proxy-env` | Use HTTP_PROXY/HTTPS_PROXY env vars | false |

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
