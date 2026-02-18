# github-router

[![CI](https://github.com/animeshkundu/github-router/actions/workflows/ci.yml/badge.svg)](https://github.com/animeshkundu/github-router/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/github-router)](https://www.npmjs.com/package/github-router)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/animeshkundu/github-router/pkgs/container/github-router)

**Use your GitHub Copilot subscription to power Claude Code, Codex CLI, or any OpenAI/Anthropic-compatible tool.**

github-router is a local reverse proxy that translates standard API formats to GitHub Copilot's backend. One command to start, copy-paste configs for your tools—no cloud proxy, no per-token costs.

```
Your Tool → github-router → GitHub Copilot API
             (translates)    (processes request)
```

> [!WARNING]
> **Unofficial Project**: Not supported by GitHub. May break with API changes. Use responsibly.
> Review the [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot) and [Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github).

---

## Table of Contents

- [Why github-router?](#why-github-router)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Usage](#usage)
  - [Claude Code](#use-with-claude-code)
  - [Codex CLI](#use-with-codex-cli)
  - [Any OpenAI Client](#use-with-any-openai-compatible-tool)
- [API Endpoints](#api-endpoints)
- [Models](#models)
- [Features](#features)
- [Docker](#docker)
- [CLI Reference](#cli-reference)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Why github-router?

**Stop paying per-token. Leverage your existing GitHub Copilot subscription.**

- 💰 **Cost Effective**: Already paying for Copilot? Use it with any AI tool without additional API costs
- 🔒 **Local & Private**: Runs on your machine. No cloud proxy. Your code stays on your device
- 🔌 **Universal Compatibility**: Works with any OpenAI or Anthropic API-compatible tool
- ⚡ **Zero Configuration**: Authenticate once, start the proxy, copy-paste config
- 🌊 **Full Streaming**: Real-time SSE streaming for both OpenAI and Anthropic formats
- 🚀 **Multiple Models**: Access GPT-4, Claude, o3, and Codex models through one endpoint

**Perfect for**:
- Using Claude Code with your Copilot subscription
- Running Codex CLI with gpt-5-codex models
- Testing AI integrations locally
- Corporate environments with Copilot Enterprise
- Cost optimization while maintaining access to multiple models

---

## Quick Start

**Get running in 60 seconds:**

```bash
# 1. Authenticate (one-time)
npx github-router@latest auth

# 2. Start the proxy
npx github-router@latest start
```

The server runs at `http://localhost:8787`. Now pick your tool below 👇

---

## Installation

### npm (Recommended)

```bash
npm install -g github-router
```

### npx (No Install)

```bash
npx github-router@latest <command>
```

### Docker

```bash
docker pull ghcr.io/animeshkundu/github-router:latest
```

### From Source

```bash
git clone https://github.com/animeshkundu/github-router.git
cd github-router
bun install
bun run build
```

**Requirements**: Node.js 18+ or Bun 1.0+

---

## Usage

### Use with Claude Code

**Option A: Interactive (Recommended)**

```bash
npx github-router@latest start --claude-code
```

Select your models, and a launch command gets copied to your clipboard. Paste it in a new terminal.

**Option B: Manual Configuration**

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

**Option C: Auto-Launch**

Start server AND Claude Code together:

```bash
npx github-router claude
# Or with custom model:
npx github-router claude -m gpt-4o
```

---

### Use with Codex CLI

**Option A: One Command**

```bash
npx github-router@latest start --codex
```

**Option B: Manual Setup**

```bash
export OPENAI_BASE_URL="http://localhost:8787/v1"
export OPENAI_API_KEY="dummy"
codex -m gpt5.2-codex
```

**Option C: Auto-Launch**

```bash
npx github-router codex
# Or with custom model:
npx github-router codex -m gpt-4.1
```

---

### Use with Any OpenAI-Compatible Tool

Point any tool at `http://localhost:8787/v1`:

**curl Example**

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

**Python (OpenAI SDK)**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8787/v1",
    api_key="dummy"  # Any value works
)

response = client.chat.completions.create(
    model="gpt-4.1",
    messages=[{"role": "user", "content": "Hello"}]
)
```

**Python (Anthropic SDK)**

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:8787",
    api_key="dummy"
)

response = client.messages.create(
    model="claude-sonnet-4",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}]
)
```

**Node.js**

```javascript
const response = await fetch('http://localhost:8787/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-4.1',
    messages: [{ role: 'user', content: 'Hello' }]
  })
});
```

---

## API Endpoints

| Endpoint | Method | Format | Features |
|----------|--------|--------|----------|
| `/v1/chat/completions` | POST | OpenAI Chat Completions | Streaming, Vision, Tools |
| `/v1/responses` | POST | OpenAI Responses (Codex) | Codex models only, Web search |
| `/v1/messages` | POST | Anthropic Messages | Translation, Beta headers |
| `/v1/messages/count_tokens` | POST | Anthropic Token Counting | Estimate token usage |
| `/v1/models` | GET | OpenAI Model List | Model capabilities & limits |
| `/v1/embeddings` | POST | OpenAI Embeddings | Text embeddings |
| `/v1/search` | POST | Web Search | Rate-limited search |
| `/usage` | GET | Usage Stats | Copilot quotas & reset dates |

**Note**: OpenAI-compatible endpoints are also available without the `/v1` prefix (e.g., `/chat/completions`). Anthropic endpoints are only available under `/v1/messages`.

<details>
<summary><b>Model / Endpoint Compatibility</b></summary>

| Model | /chat/completions | /responses | /messages |
|-------|-------------------|------------|-----------|
| gpt-4.1, gpt-4o | ✅ | ✅ | ✅ |
| gpt5.2-codex, gpt-5.1-codex-mini | ❌ | ✅ | ❌ |
| claude-sonnet-4, claude-opus-4 | ✅ | ❌ | ✅ |
| o3, o4-mini | ✅ | ✅ | ✅ |

**Important**: gpt-5-codex models ONLY work via `/responses` endpoint.

</details>

---

## Models

Access 15+ AI models through a single proxy:

### GPT Models
- `gpt-4.1` - Latest GPT-4 with extended context
- `gpt-4o` - Optimized variant with vision support
- `gpt-4.1-mini` - Fast, cost-effective model

### Claude Models (via Translation)
- `claude-sonnet-4` - Latest Sonnet model
- `claude-opus-4` - Most capable Claude model

### Codex Models (Code Generation)
- `gpt5.2-codex` - Advanced code generation
- `gpt-5.1-codex-mini` - Fast code completions

### Reasoning Models
- `o3` - Advanced reasoning
- `o4-mini` - Compact reasoning model

**Check Available Models**:

```bash
curl http://localhost:8787/v1/models
```

---

## Features

### 🔄 Multi-Format API Translation
- **OpenAI Chat Completions**: Full support for streaming & non-streaming
- **Anthropic Messages**: Complete translation with beta header support
- **OpenAI Responses**: For Codex models with automatic tool handling

### 🎯 Smart Rate Limiting
- **Reject Mode**: Return 429 errors when rate limit exceeded
- **Queue Mode**: Automatically wait and queue requests (`--wait` flag)
- Protect your Copilot quota with customizable limits

### 👁️ Vision & Multimodal Support
- Automatic image detection in messages
- Base64 and URL image handling
- Works with gpt-4.1, gpt-4o, and vision-enabled models

### 🔍 Integrated Web Search
- Automatic when `web_search` tool is requested
- Rate-limited to 3 searches/second
- Uses Copilot's internal search API

### 🛠️ Function Calling
- Full tool/function calling support
- Automatic type validation and cleanup
- Works with both OpenAI and Anthropic formats

### 🐳 Docker Ready
- Pre-built images: `ghcr.io/animeshkundu/github-router`
- Health check monitoring
- Volume support for persistent tokens
- Docker Compose examples

### 📊 Usage Monitoring
- Real-time quota tracking
- Usage dashboard at `/usage`
- Web UI for quota visualization

---

## Docker

### Pull Pre-Built Image

```bash
docker pull ghcr.io/animeshkundu/github-router:latest
docker run -p 8787:8787 -e GH_TOKEN=your_token ghcr.io/animeshkundu/github-router
```

### Build Locally

```bash
docker build -t github-router .
docker run -p 8787:8787 -e GH_TOKEN=your_token github-router
```

### Docker Compose

```yaml
services:
  github-router:
    image: ghcr.io/animeshkundu/github-router:latest
    ports:
      - "8787:8787"
    environment:
      - GH_TOKEN=your_github_token_here
    restart: unless-stopped
```

<details>
<summary><b>Persistent Token Storage</b></summary>

Mount a volume to persist your authentication token:

```bash
mkdir -p ./github-router-data
docker run -p 8787:8787 \
  -v $(pwd)/github-router-data:/root/.local/share/github-router \
  ghcr.io/animeshkundu/github-router
```

</details>

---

## CLI Reference

### Commands

```bash
github-router auth              # Authenticate with GitHub (one-time)
github-router start [options]   # Start the proxy server
github-router claude [options]  # Start server + launch Claude Code
github-router codex [options]   # Start server + launch Codex CLI
github-router check-usage       # Show Copilot usage & quotas
github-router debug [--json]    # Print diagnostic info
```

### Server Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--port, -p <port>` | Port to listen on | 8787 |
| `--verbose, -v` | Enable debug logging | false |
| `--account-type, -a <type>` | `individual`, `business`, or `enterprise` | enterprise |
| `--rate-limit, -r <seconds>` | Minimum seconds between requests | - |
| `--wait, -w` | Queue requests instead of rejecting on rate limit | false |
| `--manual` | Require manual approval for each request | false |
| `--github-token, -g <token>` | Pass token directly (skips auth flow) | - |
| `--claude-code, --cc` | Generate Claude Code launch command | false |
| `--codex, --cx` | Generate Codex CLI launch command | false |
| `--model, -m <model>` | Override default model for tool commands | - |
| `--show-token` | Display tokens in console logs | false |
| `--proxy-env` | Use HTTP_PROXY/HTTPS_PROXY env vars | false |

### Examples

```bash
# Start with rate limiting (5 seconds between requests)
github-router start --rate-limit 5 --wait

# Start on custom port with debug logging
github-router start --port 3000 --verbose

# Start with manual approval for each request
github-router start --manual

# Check your Copilot usage
github-router check-usage

# Debug information as JSON
github-router debug --json
```

---

## Configuration

### Environment Variables

- `GH_TOKEN`: GitHub authentication token (alternative to auth flow)
- `COPILOT_API_URL`: Override Copilot API base URL
- `HTTP_PROXY`, `HTTPS_PROXY`: Proxy settings (with `--proxy-env`)

### Token Storage

- **Path**: `~/.local/share/github-router/github_token`
- **Permissions**: 0600 (owner read/write only)
- **Format**: Plain text GitHub personal access token

### Account Types

- `individual`: Standard GitHub Copilot subscription
- `business`: GitHub Copilot Business
- `enterprise`: GitHub Copilot Enterprise (default)

All types use the same API endpoint: `https://api.githubcopilot.com`

---

## Troubleshooting

<details>
<summary><b>Authentication Fails</b></summary>

**Symptom**: `github-router auth` fails or shows "Invalid token"

**Solutions**:
1. Check your GitHub Copilot subscription is active
2. Run `github-router debug` to verify token status
3. Try passing token directly: `github-router start -g YOUR_TOKEN`
4. Delete old token: `rm ~/.local/share/github-router/github_token` and re-authenticate

</details>

<details>
<summary><b>Connection Refused Errors</b></summary>

**Symptom**: `ECONNREFUSED` when making requests

**Solutions**:
1. Verify proxy is running: `curl http://localhost:8787/`
2. Check port isn't in use: `lsof -i :8787`
3. Try a different port: `github-router start --port 8788`
4. Check firewall settings

</details>

<details>
<summary><b>Model Not Supported</b></summary>

**Symptom**: Error like "Model gpt5.2-codex not supported on /chat/completions"

**Solution**: gpt-5-codex models ONLY work on `/responses` endpoint:

```bash
# ✅ Correct
curl http://localhost:8787/v1/responses -d '{"model":"gpt5.2-codex",...}'

# ❌ Wrong
curl http://localhost:8787/v1/chat/completions -d '{"model":"gpt5.2-codex",...}'
```

</details>

<details>
<summary><b>Rate Limit Errors (429)</b></summary>

**Symptom**: `429 Too Many Requests` responses

**Solutions**:
1. Enable rate limiting: `github-router start --rate-limit 3 --wait`
2. Check your quota: `github-router check-usage`
3. Wait for quota reset (shown in usage output)

</details>

<details>
<summary><b>Streaming Not Working</b></summary>

**Symptom**: No streaming output, request hangs

**Solutions**:
1. Ensure `stream: true` is set in request body
2. Check Content-Type headers are correct
3. Verify your HTTP client supports SSE (Server-Sent Events)
4. Try non-streaming first to isolate issue

</details>

<details>
<summary><b>Docker Container Won't Start</b></summary>

**Symptom**: Container exits immediately

**Solutions**:
1. Ensure `GH_TOKEN` environment variable is set
2. Check logs: `docker logs <container-id>`
3. Verify port 8787 isn't already in use
4. Try running with volume mount for token persistence

</details>

### Still Having Issues?

1. Run diagnostics: `github-router debug --json`
2. Check [GitHub Issues](https://github.com/animeshkundu/github-router/issues)
3. Enable verbose logging: `github-router start --verbose`
4. Join [Discussions](https://github.com/animeshkundu/github-router/discussions)

---

## Development

### Setup

```bash
# Clone repository
git clone https://github.com/animeshkundu/github-router.git
cd github-router

# Install dependencies (Bun recommended)
bun install
# or
npm install

# Run in development mode
bun run dev
```

### Commands

```bash
bun run dev          # Dev server with hot reload
bun test             # Run all tests
bun run lint:all     # Lint all files
bun run typecheck    # TypeScript type checking
bun run build        # Build for distribution
bun run start        # Production server
```

### Project Structure

```
src/
├── main.ts              # CLI entry point
├── server.ts            # Hono web server
├── routes/              # API endpoint handlers
│   ├── chat-completions/
│   ├── responses/
│   ├── messages/        # Anthropic translation
│   ├── models/
│   └── ...
├── services/            # External API clients
│   ├── copilot/
│   └── github/
└── lib/                 # Shared utilities
```

### Testing

```bash
# Run all tests
bun test

# Run specific test file
bun test tests/create-chat-completions.test.ts

# Watch mode
bun test --watch
```

### Code Style

- **TypeScript**: Strict mode enabled
- **ESLint**: typescript-eslint + eslint-config-prettier
- **Imports**: Use `~/` alias for `src/` imports
- **Formatting**: Prettier with pre-commit hooks

---

## Contributing

We welcome contributions! Here's how to get started:

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/amazing-feature`
3. **Make** your changes and add tests
4. **Test**: `bun test` and `bun run lint:all`
5. **Commit**: `git commit -m "Add amazing feature"`
6. **Push**: `git push origin feature/amazing-feature`
7. **Open** a Pull Request

### Development Guidelines

- Write tests for new features
- Follow existing code style
- Update documentation for API changes
- Keep commits focused and descriptive

### Reporting Issues

When reporting bugs, please include:
- Output from `github-router debug --json`
- Steps to reproduce
- Expected vs actual behavior
- Environment (OS, Node/Bun version)

---

## Architecture

github-router uses two patterns:

1. **Passthrough**: Direct proxy for native Copilot formats (chat-completions, responses)
2. **Translation**: Format conversion for Anthropic APIs (messages)

```
┌─────────────────┐
│   Your Tool     │
│  (Claude Code)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ github-router   │
│  Translation    │ ← Converts Anthropic ↔ OpenAI formats
│    + Proxy      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ GitHub Copilot  │
│      API        │
└─────────────────┘
```

**Learn more**: [Architecture Documentation](docs/ARCHITECTURE.md)

---

## Security

- **Local only**: No cloud proxy, all traffic stays on your machine
- **Token storage**: Saved with 0600 permissions (owner read/write only)
- **No telemetry**: We don't collect any usage data
- **Open source**: Audit the code yourself

**Note**: Your GitHub token provides access to Copilot. Keep it secure and don't share it.

---

## Roadmap

- [ ] GraphQL API support
- [ ] Built-in web UI for configuration
- [ ] Multi-user support for teams
- [ ] Request/response caching
- [ ] Metrics and analytics dashboard
- [ ] Plugin system for custom providers

---

## Acknowledgments

- Built with [Hono](https://hono.dev/), [Bun](https://bun.sh/), and [TypeScript](https://www.typescriptlang.org/)
- Inspired by the need to leverage existing Copilot subscriptions
- Thanks to all [contributors](https://github.com/animeshkundu/github-router/graphs/contributors)

---

## License

[MIT](LICENSE) © 2025

---

## Links

- **GitHub**: [animeshkundu/github-router](https://github.com/animeshkundu/github-router)
- **npm**: [@github-router](https://www.npmjs.com/package/github-router)
- **Docker**: [ghcr.io/animeshkundu/github-router](https://github.com/animeshkundu/github-router/pkgs/container/github-router)
- **Documentation**: [API Reference](docs/API-REFERENCE.md) • [Architecture](docs/ARCHITECTURE.md) • [Development](docs/DEVELOPMENT.md)
- **Community**: [Issues](https://github.com/animeshkundu/github-router/issues) • [Discussions](https://github.com/animeshkundu/github-router/discussions)

---

<div align="center">

**Made with ❤️ by developers, for developers**

[⭐ Star on GitHub](https://github.com/animeshkundu/github-router) · [📦 Install via npm](https://www.npmjs.com/package/github-router) · [🐳 Pull Docker Image](https://github.com/animeshkundu/github-router/pkgs/container/github-router)

</div>
