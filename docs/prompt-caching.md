# Prompt caching

github-router preserves caller-owned cache controls and adds only mechanisms
that showed a measurable benefit against Copilot.

| Provider / route | Router behavior |
|---|---|
| Claude `/v1/messages` passthrough | Preserve caller `cache_control` placement. Never rewrite a caller policy. |
| Router-owned Claude calls | For reusable prefixes of at least 4096 characters, mark the last non-deferred tool and stable system boundary; conversation mode may add the last two cacheable messages. Hard maximum: four markers. |
| GPT-5.6 `/responses` internal calls | Use explicit mode with a stable system breakpoint, opaque hashed key, and 30-minute TTL. |
| GPT-5.5 / older GPT / Codex | Provider-managed automatic caching only. |
| Gemini Chat | Provider-managed automatic caching only. |
| Grok Responses | Provider-managed automatic caching only. |
| Public OpenAI-compatible routes | Caller-owned fields pass through; the router does not synthesize policy. |

GPT-5.6 explicit caching is applied to translated Claude Code conversations,
worker conversations, reusable peer/advisor prefixes, and browser-compressor
prefixes. It is omitted for short prefixes and one-shot requests. Disable it
with `GH_ROUTER_DISABLE_GPT56_EXPLICIT_CACHE=1`.

Router-owned Claude marking is limited to internal calls and can be disabled
with `GH_ROUTER_DISABLE_CLAUDE_CACHE_POLICY=1`.

Set `GH_ROUTER_LOG_CACHE=1` to log component hashes/lengths and the first
changed prefix component. Prompt text, tool arguments, cache keys, paths, and
user identifiers are never logged.

Web-search placement and rollback controls are documented in
[`web-search.md`](web-search.md). Compatibility evidence is recorded in
[`copilot-compat-matrix.md`](copilot-compat-matrix.md).
