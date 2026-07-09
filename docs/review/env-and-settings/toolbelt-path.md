# Toolbelt PATH provisioning

Governing lens: raise the floor, never nerf. This prepends a bin dir of curated CLI tools
to the spawned agent's PATH so the model can call `rg`/`fd`/`jq`/etc. natively. The
model-facing text that ANNOUNCES these tools (the toolbelt one-liner in the mirrored
CLAUDE.md) is reviewed separately; this doc covers the behavior-shaping PATH injection.

## 1. Identity

| Field | Value |
|---|---|
| Setting | PATH prepend of `PATHS.TOOLBELT_BIN_DIR` |
| Where set | `src/lib/server-setup.ts:780-782` (in `getClaudeCodeEnvVars`), via `toolbeltPathOverride` (`src/lib/toolbelt/path-inject.ts:31-40`) |
| Gate | `toolbeltEnabled()` — only when the toolbelt feature is on |
| Casing safety | reuses the parent's existing PATH key casing (`pathEnvKey`), and `collapsePathKeys` (`src/lib/launch.ts:258` via `buildLaunchCommand`) folds any duplicate `Path`/`PATH` on Windows |
| Opt-out | `GH_ROUTER_DISABLE_TOOLBELT=1` (whole toolbelt); `GH_ROUTER_TOOLBELT_SKIP=jq,yq` (per-tool) — per root `CLAUDE.md` |
| Design | root `CLAUDE.md` "LLM toolbelt" section |

## 2. What it does + behavior effect

Prepends the toolbelt bin dir to the spawned agent's PATH so `rg`/`fd`/`jq`/`sd`/`sg`/`yq`/
`scc`/`difft`/`gron` resolve as native commands the model can invoke through Bash. Only tools
NOT already on the user's PATH are materialized (gap-fill — never shadows a user's pinned
`jq` or Go-vs-Python `yq`). The tools lazy-download from version-pinned GitHub releases with
hardcoded-in-source SHA256 verified before extraction.

The PATH injection is Windows-casing-safe by construction:

- `pathEnvKey` (`path-inject.ts:18-23`) finds the parent's existing PATH key case-insensitively
  and reuses it, so the override doesn't create a duplicate `Path` alongside `PATH`.
- `collapsePathKeys` (`path-inject.ts:49-61`) is a defense-in-depth backstop: if a mismatched-casing
  merge ever produced two PATH keys, it folds them into one canonical key, keeping the longest value
  (the toolbelt-prepended PATH is strictly longer, so the injection survives). Called in
  `buildLaunchCommand` (`src/lib/launch.ts:258-261`) after merging parent + override.

**Anti-shadow interaction**: `buildLaunchCommand` resolves the top-level CLI (`claude`/`codex`)
to an ABSOLUTE path against the CLEAN parent PATH (excluding cwd) BEFORE the toolbelt PATH is
applied (`src/lib/launch.ts:248-256`). So the toolbelt PATH only affects the AGENT's own tool
lookups, never which CLI the launcher spawns — a planted `claude.cmd` in the toolbelt dir (or an
untrusted cwd) can't hijack the launch.

## 3. Raise-the-floor assessment

**Expands capability.** The model gets fast native CLIs (`rg` over grep, `fd` over find, `jq`,
`sg`, etc.) it can call directly, which the operating-defaults also steer it to prefer. Pure
addition to the tool surface, and gap-fill means it adds tools without displacing the user's own.

**Is the default the best choice?** Yes:

- Gap-fill (only tools absent from the user's PATH) is exactly the right amount — it never shadows
  a pinned binary, so a user who has a specific `jq`/`yq` keeps theirs.
- SHA-pinned, regular-files-only extraction is the correct supply-chain posture (vets the download
  before trusting it).
- Materialization runs in the background (never blocks launch), and the anti-shadow absolute-path
  resolution of the CLI itself means the PATH prepend can't compromise launch integrity.
- Per-tool + whole-toolbelt opt-outs give clean escape hatches.

**Could it nerf?** The one theoretical risk — a toolbelt tool shadowing a user's binary — is
explicitly prevented by gap-fill (only absent tools are exposed). The anti-shadow CLI resolution
prevents the inverse (a planted tool shadowing the CLI). Neither nerfs.

**Drift risk.** Low. The tool set and SHAs are version-pinned in `manifest.ts`; a stale pin means
an older tool version, not a broken PATH. The casing helpers are platform-robust and unit-tested.

## 4. Findings

- No Critical/Important/Suggestion findings on the PATH-injection mechanism. Gap-fill + casing
  safety + anti-shadow CLI resolution + SHA-pinned extraction is a correct, floor-raising design.
- The model-facing ANNOUNCEMENT of these tools (the toolbelt one-liner injected into the mirrored
  CLAUDE.md) is a separate surface reviewed in the injected-prompt docs — noted here only so the
  PATH behavior and its advertisement aren't conflated.

## 5. Verdict

Correct and floor-raising: adds fast native CLIs to the model's tool surface via gap-fill (never
shadows the user's binaries), with Windows-casing safety and anti-shadow CLI resolution that keep
the PATH prepend from compromising launch integrity. Clean opt-outs. No nerf.
