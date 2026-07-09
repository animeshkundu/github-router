# Review: `mcp__fleet__read_file`

> Per-tool audit of the model-facing surface github-router auto-injects. One doc per injected MCP tool.
> Reviewer: meta subagent. Fill every section. Cite `file:line`. Verify claims against code, do not assert.

## 1. Identity

| Field | Value |
|---|---|
| MCP path | `mcp__fleet__read_file` |
| Group / server | `fleet` (serverInfo `github-router-fleet`) |
| Wire tool name | `read_file` |
| Definition | `src/lib/fleet/tools.ts:721` (factory `tool()` at `:283`) |
| Always-on? | gated by `--fleet` / `GH_ROUTER_ENABLE_FLEET=1` |
| Capability gate | `fleet` → `fleetToolsEnabled()` (`src/lib/mcp-capabilities.ts:182`) |
| Backing model / endpoint | server-side fn (HTTP relay to remote ai-or-die `GET /api/files/content`, `src/lib/fleet/client.ts:434`) |
| Write-capable | no (read-only file fetch) |

## 2. Injected surfaces (verbatim)

### 2a. Tool `description` (shown in `tools/list`)

Description string (`src/lib/fleet/tools.ts:723`):

> Read a file from one fleet instance via its existing /api/files/content endpoint.

Input schema (`tools.ts:724-727`), `required: ["path"]`, `additionalProperties: false`:

- `instance` (string): "Instance id or label. Defaults to the registry default, or the sole instance."
- `path` (string, required): "Remote file path to read."

### 2b. System prompt (`--append-system-prompt`)

`buildPeerAwarenessSnippet` (`src/lib/peer-mcp-personas.ts:555-646`) does NOT name this tool. It never names the `fleet` group at all: the two emitted paragraphs cover only `peers` / `search` / `workers` / `orchestrate` / `decide` / `browser`, each behind an `opts.*Available` flag. There is no `fleet` branch, no `opts.fleetAvailable` parameter (`:555-567`), and no literal "fleet" anywhere in the function. So neither the tool nor its group appears in the system prompt. The tool `description` (2a) is the ONLY model-facing surface.

### 2c. CLAUDE.md (mirrored `<CLAUDE_CONFIG_DIR>/CLAUDE.md`)

None. The mirrored CLAUDE.md peer-awareness block is the same text as 2b, which omits fleet. The checked-in repo root `CLAUDE.md` also has no fleet coverage: `grep -n 'fleet|Fleet|read_file|ai-or-die'` over `CLAUDE.md` returns zero matches. No injected marker block (peer-awareness, artifact-panel, operating-defaults, toolbelt) covers this tool. Fleet is documented only in `docs/aiordie-fleet.md` (operator-facing, `:63-66` lists `read_file` among the tools) and `docs/fleet-control-plane-contract.md` — neither is injected into the model context.

## 3. Assessment

### 3a. Description quality

- **Clarity & routing signal.** Weak. "Read a file from one fleet instance via its existing /api/files/content endpoint" tells the model the mechanism (an HTTP endpoint on the remote) but not the intent. It gives no when-to-use / when-NOT signal, and no relationship to the sibling reads (`list_dir`, `search`, `git_show`) or to the local `Read` tool. A model must infer from the `fleet` server name plus the sibling `read_session` (which is transcript output, not files) that this reads a file on a REMOTE box, not the local workspace. The endpoint path `/api/files/content` is an implementation detail of no use to the model (it never constructs that URL) and spends description budget for zero routing value.
- **Accuracy vs implementation.** Accurate. The handler (`tools.ts:728-732`) resolves the instance (`resolve(optionalString(args,"instance"))`, defaulting via the registry) and calls `clientFor(instance).readFile(path)`, which is `GET /api/files/content?path=<path>` (`client.ts:434-436`). No stale model id / default / gate. The `instance` default behavior ("registry default, or the sole instance") matches `resolveInstance` usage elsewhere in the file.
- **Schema minimality.** Minimal and correct. Two fields, both load-bearing: `path` is required and is the file to read; `instance` selects the target and legitimately defaults. No echoed-input, diagnostic-only, or non-actionable field. Passes the "ruthlessly minimal" bar.

### 3b. System-prompt coverage

- **Omitted.** By design and consistent with the group's opt-in nature — `buildPeerAwarenessSnippet` gates every mention on an availability flag and no `fleet` flag is threaded in (`:555-567`), so an off-by-default, operator-only group correctly stays out of the always-on snippet. This matches the `first-mate` group, which is likewise absent from the snippet body.
- **Consequence.** With no system-prompt or CLAUDE.md line, the tool's discoverability rests entirely on `tools/list`. That is acceptable for an opt-in operator tool the user explicitly enabled with `--fleet`; the operator who flips the flag knows the surface exists. No framing-constraint (imperative / hedge / anchor) issue arises because there is no clause to violate one.

### 3c. CLAUDE.md coverage

- **None, and non-drifted by construction** — absence cannot drift. The injected block and the checked-in root CLAUDE.md agree trivially (both silent). The operator docs (`docs/aiordie-fleet.md:63-66`) list `read_file` accurately and are internally consistent with the code, but are not part of the model-facing surface.

### 3d. Cross-surface consistency

No contradictions. Description ↔ (absent) system prompt ↔ (absent) CLAUDE.md ↔ code all agree: a read-only remote file fetch, `path` required, `instance` optional. The only cross-surface note is that the sole model-facing surface is the description, which the team-lead brief already flagged and which is acceptable for an opt-in group.

## 4. Findings

- **[Important]** `src/lib/fleet/tools.ts:723` — the description does not convey that `path` is an **unconstrained, arbitrary path on the remote host**, and there is NO path sanitization anywhere in the router. The handler forwards `path` verbatim as a query param (`client.ts:434-436`); the router applies no allowlist, no traversal check, and no secret-file denylist (contrast the WORKER read tools, which enforce a `.env*`/`*.pem`/`id_rsa*`/`.ssh/` denylist per the root CLAUDE.md worker-tools section). Whether `../../etc/passwd`, `~/.ssh/id_ed25519`, or an absolute path outside the workspace is served is **entirely** the remote ai-or-die `/api/files/content` endpoint's decision, and that contract is not asserted here. This is not Critical from the router's side (the router is a faithful relay and the operator opted in with `--fleet` to a host they control), but the model-facing description gives the model no signal that a read can reach outside a project sandbox, so a model told "read the config" could exfiltrate a secret file from a remote box into the transcript with no guard rail. *Fix:* either (a) add one clause to the description making the sandbox boundary explicit and deferring it to the remote ("reads any path the remote ai-or-die host permits; may reach outside the workspace — the remote enforces its own path policy"), and/or (b) document the required remote-side path constraint in `docs/aiordie-fleet.md` / the control-plane contract so the boundary is a stated invariant rather than an unspoken assumption. Preferred: (a), since the description is the only model-facing surface.
- **[Suggestion]** `src/lib/fleet/tools.ts:723` — replace the endpoint mechanism with a routing signal. Drop "via its existing /api/files/content endpoint" (an implementation detail the model can't act on) and add when-to-use / vs-siblings framing, e.g. "Read a file from a remote fleet instance's filesystem (choose the instance, or default to the sole/registry-default one). Use for remote files; use `list_dir` to enumerate, `search` to find, `git_show` for a revision, and `read_session` for a session's terminal output (not a file)." This is purely additive clarity, non-blocking.

## 5. Verdict

**N** — the injected surface is accurate, minimal, and internally consistent, but the single model-facing description omits the load-bearing fact that `read_file` performs an **unsanitized, potentially-out-of-sandbox read on a remote host** with all path policy delegated to the remote. Single most important fix: add a sandbox-boundary clause to the description (finding 1) so the model understands a read can reach secret files the router does not guard.
