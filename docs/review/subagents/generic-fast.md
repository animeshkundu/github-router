# Retired subagent: `generic-fast`

`generic-fast` is no longer emitted. Its former chain was `gemini-3.6-flash` → `gemini-3.5-flash`, with a 1M context floor and the full inherited toolset.

The preregistered comparison was run on 2026-08-11 through this proxy using a fixed prompt, three times per model. Approximate output throughput was:

- `gpt-5.6-luna`: 82 tokens/s
- `gemini-3.6-flash`: 34 tokens/s
- `gemini-3.5-flash`: 24–35 tokens/s

The live catalog's per-1M-token prices were 20/120 input/output for Luna, 150/750 for Gemini 3.6 Flash, and 150/900 for Gemini 3.5 Flash. Their context windows were 1.05M, 1.00M, and 1.00M respectively. Luna therefore dominated every member of the former chain on measured speed, input price, output price, and context.

The documented consequence was applied: `generic-fast` was deleted, `generic-cheap` was renamed to [`general-purpose-fast`](general-purpose-fast.md), and the roster now has one earned catch-all rather than two overlapping routes. The retired name remains permanently in `PEER_AGENT_MD_FILENAME` so a `.md` file left by a crashed older session is still sweepable.

**Verdict: retired by measurement.**
