# Auto-injected MCP tool review

A per-tool audit of the model-facing surface `github-router` injects when it launches Claude Code. For every injected MCP tool we review the three surfaces the model actually reads:

1. **Tool `description`** — the string in `tools/list`, shown to the model when it picks a tool. Per-tool, lives in the tool-definition arrays.
2. **System prompt** — appended via `--append-system-prompt`. Fed by `buildPeerAwarenessSnippet()` (`src/lib/peer-mcp-personas.ts:555`), which names only *some* tools (group-level), plus the operating-defaults directive.
3. **CLAUDE.md** — the mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`, written by `src/lib/claude-md-injection.ts`. Marker blocks: peer-awareness (same text as the system-prompt snippet), style, operating-defaults, toolbelt, and the artifact-panel directive. Reaches Agent-tool subagents / agent-teams teammates that inherit `CLAUDE_CONFIG_DIR` but not `--append-system-prompt`.

One meta subagent reviewed each tool and wrote `docs/review/mcp/<group>/<tool>.md` from `_TEMPLATE.md`. Systemic findings are aggregated in [`FINDINGS.md`](./FINDINGS.md).

## Injection-surface map (the key asymmetry)

The three surfaces do **not** cover the same tools. The tool `description` exists for every tool; the system-prompt/CLAUDE.md awareness snippet names tools unevenly:

| Group | In `buildPeerAwarenessSnippet` (system prompt + mirrored CLAUDE.md)? |
|---|---|
| peers | Group + all critics named; `codex_implementer` only via the codex-cli clause |
| search | `code` (detailed) + `web` (one line) both named |
| workers | `explore/review/plan/implement/test` named; **`browse` worker omitted** |
| orchestrate | all four named (branches on worker gate) |
| decide | `stand_in` named |
| browser | lead surface (`act/observe/extract/navigate/open_tab/screenshot`) + power primitives named; **`list_tabs/close_tab/wait/download` omitted** |
| fleet | **not named at all** in the snippet |
| first-mate | only via the `/gh-first-mate` skill sentence; **individual tools not named** |
| artifact | **not in the snippet**; covered by a separate `ARTIFACT_PANEL_DIRECTIVE` (mirrored CLAUDE.md only, gated on ai-or-die tab) |

Whether each omission is by-design (tool description is enough) or a gap is exactly what the per-tool docs adjudicate.

## Full manifest (71 MCP tools, 9 groups)

Description source unless noted: `src/lib/peer-mcp-personas.ts`.

### peers — `src/lib/peer-mcp-personas.ts` (personas)  ·  gate: catalog + `--codex-cli` for implementer
| Tool | Line | Model / endpoint | Gate |
|---|---|---|---|
| codex_critic | 335 | gpt-5.6-sol `/responses` | always |
| gemini_critic | 349 | gemini-3.1-pro-preview `/chat` | `requiresGeminiCatalog` |
| codex_reviewer | 364 | gpt-5.3-codex `/responses` | always |
| gemini_reviewer | 378 | gemini-3.1-pro-preview `/chat` | `requiresGeminiCatalog` |
| opus_critic | 400 | claude-opus-5 `/messages` (4.6 fallback) | always |
| codex_implementer | 426 | gpt-5.3-codex `/responses` (write) | `--codex-cli` |

### search — `NON_PERSONA_MCP_TOOLS`  ·  always-on
| Tool | Line | Backend |
|---|---|---|
| web | 788 | Copilot `/mcp` web_search |
| code | 865 | `runUnifiedCodeSearch` (ColBERT + lexical) |

### workers — `NON_PERSONA_MCP_TOOLS`  ·  gate: `capability:"worker"` / `browse_agent`
| Tool | Line | Default model | Gate |
|---|---|---|---|
| explore | 1194 | gpt-5.6-luna high | worker |
| implement | 1276 | gpt-5.6-sol xhigh | worker |
| review | 1367 | gemini-3.1-pro-preview | worker |
| plan | 1451 | claude-opus-5 high | worker |
| test | 1529 | gpt-5.6-sol xhigh | worker |
| browse | 1905 | gpt-5.6-luna high | browse_agent |

### orchestrate — `NON_PERSONA_MCP_TOOLS`  ·  verify/attest always-on; decompose/run gated `worker`
| Tool | Line |
|---|---|
| verify_workflow | 1625 |
| decompose | 1686 |
| run_workflow | 1753 |
| attest_step | 1819 |

### decide — `NON_PERSONA_MCP_TOOLS`  ·  gate: `capability:"stand_in"`
| Tool | Line |
|---|---|
| stand_in | 1982 |

### browser — `src/lib/browser-mcp/index.ts`  ·  gate: `--browse` (+ `--power-browse` for primitives)
| Tool | Line | Tier |
|---|---|---|
| browser_list_tabs | 76 | power |
| browser_open_tab | 90 | lead |
| browser_close_tab | 116 | power |
| browser_navigate | 136 | lead |
| browser_screenshot | 163 | lead |
| browser_read_page | 185 | power |
| browser_scroll | 207 | power |
| browser_keyboard | 261 | power |
| browser_wait | 282 | power |
| browser_eval_js | 310 | power |
| browser_download | 335 | power |
| browser_mouse | 362 | power |
| browser_drag | 417 | power |
| browser_type | 464 | power |
| browser_diagnostics | 489 | power |
| browser_find | 560 | compound |
| browser_act | 594 | lead/compound |
| browser_observe | 758 | lead/compound |
| browser_extract | 784 | lead/compound |

### fleet — `src/lib/fleet/tools.ts`  ·  gate: `--fleet` / `capability:"fleet"`
| Tool | Line |
|---|---|
| list_instances | 307 |
| list_sessions | 321 |
| read_session | 334 |
| session_status | 350 |
| send_message | 363 |
| send_keys | 459 |
| respond | 510 |
| create_session | 533 |
| stop_session | 588 |
| await_turn | 609 |
| drive_task | 693 |
| read_file | 722 |
| list_dir | 735 |
| search | 748 |
| git_show | 766 |

### first-mate — `src/lib/first-mate/tools.ts`  ·  gate: `--agents` + GitHub agent token / `capability:"agents"`
| Tool | Line |
|---|---|
| start_mission | 221 |
| scaffold_repo | 267 |
| advance | 331 |
| board | 412 |
| merge_pr | 427 |
| close_pr | 488 |
| mark_ready | 533 |
| add_units | 573 |
| abandon_mission | 609 |
| mission_status | 649 |

### artifact — `src/lib/artifact/tools.ts`  ·  gate: `capability:"artifact"` (ai-or-die tab env trio)
| Tool | Line |
|---|---|
| artifact_open | 55 |
| artifact_update | 79 |
| artifact_refresh | 107 |
| artifact_await | 122 |
| artifact_dismiss | 138 |
| artifact_reply | 153 |
| artifact_end | 171 |
| artifact_poll | 186 |

## Related auto-injected surfaces (not standalone MCP tools; out of the per-tool scope)

- **`__anthropic_advisor`** — server-injected Anthropic tool on `/v1/messages` (Claude models only), dispatched to gpt-5.6-sol xhigh. Named in the awareness snippet.
- **Injected subagents** — the native `implementer`, `reviewer`, `brainstorm`, `scout`, and `scribe`; `peer-review-coordinator`; and the `worker-*` background dispatchers. `implementer`, `reviewer`, `brainstorm`, and `scribe` are always emitted, omitting `model:` to inherit the lead if their preferred chain misses. `scout` is omitted when its cheap-tier chain misses. These are agent definitions, not MCP tools.
- **Injected skills** — `/gh-research`, `/gh-orchestrate`, `/gh-floor-keeper`, `/gh-first-mate` (`src/lib/injected-skills/`).

## Review methodology

Each per-tool doc follows [`_TEMPLATE.md`](./_TEMPLATE.md): identity → verbatim surfaces (description, system-prompt clause, CLAUDE.md clause) → assessment (description quality, system-prompt coverage, CLAUDE.md coverage, cross-surface consistency) → findings (Critical/Important/Suggestion, `file:line` + fix) → one-line verdict. The bar: is each tool's injected surface **correct** (matches code), **minimal** (per the ruthlessly-minimal-surface principle), **consistent** across the three surfaces, and **well-routed** (the model learns when to use and when not to use it)?
