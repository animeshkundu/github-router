# github-router

[![CI](https://github.com/animeshkundu/github-router/actions/workflows/ci.yml/badge.svg)](https://github.com/animeshkundu/github-router/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/github-router)](https://www.npmjs.com/package/github-router)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Use your GitHub Copilot subscription as an OpenAI- and Anthropic-compatible API. Route Claude Code, Codex CLI, and any OpenAI client through a local proxy—streaming included.

> [!WARNING]
> Unofficial. Not supported by GitHub. May break. Use responsibly. Review the [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot) and [Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github).

## Table of Contents

- [Why github-router](#why-github-router)
- [Quickstart](#quickstart)
- [Works with](#works-with)
- [API surface](#api-surface)
- [Model routing](#model-routing)
- [Operations & observability](#operations--observability)
- [CLI reference](#cli-reference)
- [Docker](#docker)
- [Configuration snippets](#configuration-snippets)
- [FAQ](#faq)
- [Development](#development)

## Why github-router

- OpenAI + Anthropic shapes: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, embeddings, model list, and search.
- Streaming-first: SSE support for Chat Completions, Responses, and Anthropic Messages with correct end-of-stream handling.
- Local-first: Copilot tokens are stored on disk; optional `--manual` approvals and `--rate-limit` throttling.
- Zero client changes: Point any OpenAI-compatible SDK at `http://localhost:8787/v1` with a dummy key.
- Friendly CLI helpers: `--claude-code` and `--codex` generate ready-to-run launch commands.

## Quickstart

1) Authenticate once:

```sh
npx github-router@latest auth
```

2) Start the proxy (Claude Code helper shown):

```sh
npx github-router@latest start --claude-code
```

3) Point your client at the proxy:

```sh
export OPENAI_BASE_URL="http://localhost:8787/v1"
export OPENAI_API_KEY="dummy"
curl "$OPENAI_BASE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"Hello"}]}'
```

## Works with

### Claude Code

Interactive helper (copies launch command):

```sh
npx github-router@latest start --claude-code
```

Manual config (`.claude/settings.json`):

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
  "permissions": { "deny": ["WebSearch"] }
}
```

### Codex CLI

```sh
npx github-router@latest start --codex
# or
export OPENAI_BASE_URL="http://localhost:8787/v1"
export OPENAI_API_KEY="dummy"
codex -m gpt5.2-codex
```

### Any OpenAI-compatible client

Point your SDK at `http://localhost:8787/v1` with any API key. Streaming and non-streaming calls are supported.

## API surface

| Endpoint | Method | Format |
| --- | --- | --- |
| `/v1/chat/completions` | POST | OpenAI Chat Completions |
| `/v1/responses` | POST | OpenAI Responses (Codex models) |
| `/v1/messages` | POST | Anthropic Messages |
| `/v1/messages/count_tokens` | POST | Anthropic token counting |
| `/v1/models` | GET | OpenAI model list |
| `/v1/embeddings` | POST | OpenAI embeddings |
| `/v1/search` | POST | Web search |
| `/usage` | GET | Copilot usage & quotas |

OpenAI-compatible endpoints also work without the `/v1` prefix; Anthropic is only under `/v1/messages`.

## Model routing

| Model | `/chat/completions` | `/responses` |
| --- | --- | --- |
| `gpt-4.1`, `gpt-4o` | Yes | Yes |
| `gpt5.2-codex`, `gpt-5.1-codex-mini` | No | Yes |
| `claude-sonnet-4`, `claude-opus-4` | Yes (via `/messages`) | No |
| `o3`, `o4-mini` | Yes | Yes |

## Operations & observability

- Usage dashboard: open `pages/dashboard.html` to query `/usage`, visualize quotas, and inspect raw JSON.
- Manual approvals: `--manual` prompts for each request.
- Throttling: `--rate-limit <seconds>` to space requests; `--wait` queues instead of returning 429.
- Proxy awareness: `--proxy-env` respects `HTTP_PROXY`/`HTTPS_PROXY`.

Quick usage check:

```sh
curl http://localhost:8787/usage
```

## CLI reference

```
github-router start [options]    Start the proxy server
github-router auth               Authenticate with GitHub
github-router check-usage        Show Copilot usage/quotas
github-router debug              Print diagnostic info
```

| Flag | Description | Default |
| --- | --- | --- |
| `--port, -p` | Port | `8787` |
| `--verbose, -v` | Debug logging | `false` |
| `--account-type, -a` | `individual` / `business` / `enterprise` | `individual` |
| `--rate-limit, -r` | Minimum seconds between requests | - |
| `--wait, -w` | Queue requests instead of returning 429 | `false` |
| `--manual` | Approve each request interactively | `false` |
| `--github-token, -g` | Provide token directly (skip auth flow) | - |
| `--claude-code, -c` | Generate Claude Code launch command | `false` |
| `--codex` | Generate Codex CLI launch command | `false` |
| `--proxy-env` | Respect `HTTP_PROXY` / `HTTPS_PROXY` env vars | `false` |

## Docker

Pre-built image (GitHub Container Registry):

```sh
docker pull ghcr.io/animeshkundu/github-router:latest
docker run -p 8787:8787 -e GH_TOKEN=your_token ghcr.io/animeshkundu/github-router
```

Local build:

```sh
docker build -t github-router .
docker run -p 8787:8787 -e GH_TOKEN=your_token github-router
```

Compose:

```yaml
services:
  github-router:
    build: .
    ports:
      - "8787:8787"
    environment:
      - GH_TOKEN=your_token_here
    restart: unless-stopped
```

Persist tokens:

```sh
mkdir -p ./github-router-data
docker run -p 8787:8787 -v $(pwd)/github-router-data:/root/.local/share/github-router ghcr.io/animeshkundu/github-router
```

## Configuration snippets

Copilot token path: `~/.local/share/github-router/github_token` (used by auth flow). Use `--github-token` to provide one manually or mount the file inside Docker.

## FAQ

- **Is this official?** No. This is an unofficial proxy; review GitHub Copilot terms before use.
- **Does streaming work?** Yes—Chat Completions, Responses, and Anthropic Messages stream over SSE with proper end-of-stream handling.
- **Where are tokens stored?** Locally at `~/.local/share/github-router/github_token`. Mount that path in containers to persist it.
- **Can I use proxies?** Yes, pass `--proxy-env` to respect `HTTP_PROXY`/`HTTPS_PROXY`.
- **Which port is used?** `8787` by default; override with `--port` or `PORT`.

## Development

```sh
bun install
bun run dev          # Dev server with hot reload
bun test             # Run tests
bun run lint:all     # Lint
bun run typecheck    # Type check
bun run build        # Build for distribution
```

