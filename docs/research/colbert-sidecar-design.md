# ColBERT semantic code search — github-router-managed sidecar (build-ready design)

**Status:** GO (with conditions — see §13). Supersedes the NO-GO in
[`colgrep-investigation.md`](colgrep-investigation.md). The user has explicitly
opted in to a dedicated process; that earlier verdict's binding objections
("persistent index + model download + native ONNX") are now *requirements
github-router fulfils*, not reasons to abstain.

**Target:** `colgrep` from [`lightonai/next-plaid`](https://github.com/lightonai/next-plaid)
— ColBERT/PLAID late-interaction semantic code search. Rust, CPU-by-default,
native ONNX Runtime, Windows-first. Latest release **v1.5.2** (2026-06-03).

**One-paragraph digest.** colgrep is **CLI-per-invocation, not a daemon** (no
`serve`/`server`/`listen` anywhere in its source — verified by command tree and
keyword scan). So github-router does not run a persistent socket service; it
runs a **managed sidecar runner**: short-lived, PID-tracked `colgrep search` /
`colgrep init` child processes that the proxy spins up, cancels, and cleans up,
with all heavy state (the PLAID index, the ColBERT model, the ONNX Runtime
dylib) **pre-supplied and SHA256-verified by github-router** into the
router-owned data dir and injected via env (`COLGREP_DATA_DIR`, `--model
<local-dir>`, `ORT_DYLIB_PATH`). The single biggest risk is **per-query
cold-start latency**: because there's no warm process, EVERY `semantic_search`
re-loads the ONNX Runtime, builds an ONNX session, loads the model+tokenizer,
and mmaps the index — costs the OS page cache does NOT eliminate — on top of the
one-time multi-second-to-minutes full index build on a fresh machine. This makes
a **measured warm-query latency budget a hard GO gate** (§11 spike, §13
condition 1): if warm p95 is unacceptable the architecture must change, not just
its cleanup. The mitigations that hold regardless: non-blocking background
indexing on `start`, and a `status`/freshness field on the MCP tool that
degrades to lexical `code_search` while the index is
`provisioning`/`building`/`absent`/`stale` — the tool NEVER errors on a missing
index.

---

## 1. Process model — managed sidecar runner (NOT a daemon)

### Evidence

colgrep's subcommands (from `src/cli.rs:452-719`, clap `Commands` enum):
`Search`, `Status`, `Clear`, `SetModel`, `Update`, `Init`, `Settings`. Plus
bare-query default-search and `--install-*` integration flags. **There is no
`serve` / `server` / `daemon` / `listen` subcommand.** A whole-crate scan for
`fn serve|TcpListener|UnixListener|tokio::net|axum|hyper|tonic|stdin loop|repl`
returns only incidental matches (string `.replace`, comments). colgrep is a
classic batch CLI: each invocation parses args, ensures the model+ORT, runs an
incremental index update, searches, prints, and exits.

### Decision: per-invocation child processes, github-router-owned lifecycle

Do **not** invent a long-running TCP/stdio server wrapper around colgrep. It
would add a custom protocol, a port, a health endpoint, and a keep-alive
problem — all to wrap a tool that has no resident state to keep warm between
calls anyway (colgrep memory-maps the PLAID index fresh per process; warm-cache
benefit is OS page cache, which survives across short-lived processes for free).

The "dedicated process" the user opted into is satisfied by treating colgrep as
a **managed binary the proxy provisions and drives**, exactly like the toolbelt
binaries — but with PID tracking, cancellation, and a boot/exit sweep layered on
because the index-build invocations can be long. This is *simpler* than the
browser bridge (which IS a persistent process kept alive across MV3 SW dormancy)
because colgrep has nothing to keep alive.

```
+--------------------------+     tools/call            +-----------------------------+
| Claude (or any MCP       | <-----------------------> | github-router /mcp/search   |
| client)                  |   semantic_search         | (handler.ts)                |
+--------------------------+                           +--------------+--------------+
                                                                      | in-proc fn call
                                                                      v
                                                       +-----------------------------+
                                                       | src/lib/colbert/            |
                                                       |  - provision (download+sha) |
                                                       |  - index-store (paths/meta) |
                                                       |  - runner (spawn colgrep)   |
                                                       |  - lifecycle (PID/sweep)    |
                                                       +--------------+--------------+
                                                                      | spawn (shell:false,
                                                                      | native .exe), tracked PID
                                                                      v
                                                       +-----------------------------+
                                                       | colgrep search --json ...   |  short-lived
                                                       | env: COLGREP_DATA_DIR,      |  per call
                                                       |      ORT_DYLIB_PATH, --model|
                                                       +-----------------------------+
```

The only "background" long-lived activity is the **indexing-on-start** build
(§9), which is itself a tracked `colgrep init` child, fire-and-forget like
`provisionToolbelt()`, registered in the same PID ledger so the exit sweep
reaps it.

### Per-query cold-start: the cost this model pays, and the alternatives weighed

Per-invocation is the load-bearing risk, not a free win. Every `search` child
pays, even with a warm on-disk index: process spawn → ORT dylib `dlopen` → ONNX
**session construction** → model + tokenizer load → index mmap/open → incremental
update scan → query encode → JSON serialize. Page cache makes the *index mmap*
cheap on repeat calls, but it does **not** eliminate ONNX session construction or
model init — those are per-process. Realistic CPU cost is plausibly
**multi-hundred-ms to low-seconds per query**, vs ripgrep's <10ms. That is
acceptable for an **opt-in NL-intent tool** but would be unacceptable as the
default path — which is precisely why `semantic_search` is a *separate* tool from
lexical `code` (§6), and why the spike phase (§11.1) MUST measure warm p95
before the architecture is blessed.

Alternatives weighed (and why per-invocation still wins *for v1*):

| Option | Verdict |
|---|---|
| **Per-invocation CLI (chosen)** | Simplest; no protocol/port/keep-alive; matches colgrep's actual shape. Accepts per-query model-load cost. **GO for v1, gated on a measured budget.** |
| Upstream a `colgrep serve` mode | Best long-term latency (model stays warm), but requires an upstream contribution + a wire protocol + a keep-alive/dormancy story github-router would own. Deferred — revisit if the v1 budget proves the model-load cost dominant. |
| Thin Rust daemon wrapping `next-plaid` crate internals | Most control, highest build cost, forks us off the prebuilt-release supply chain (we'd build from source → no fresh-Windows guarantee). Rejected for v1. |
| Index/build-only, no query tool | Defeats the purpose (the user asked for a *search* tool). Rejected. |
| Freshness/latency predicate gating semantic vs lexical | **Adopted as a complement, not a replacement** — §6's degradation matrix routes building/stale/slow states to lexical. Doesn't remove the warm-path cost but bounds the worst case. |

If the spike shows warm p95 is unacceptable, the fallback is the
freshness-predicate-default posture (lexical by default, semantic only when a
freshness+latency predicate passes) plus prioritizing an upstream `serve` mode —
**not** shipping a slow default.

---

---

## 2. The four control surfaces colgrep gives us (all env/flag, no patching)

Everything github-router needs to manage state externally is already a
first-class colgrep env var or CLI flag. **No fork, no patch.**

| Concern | Mechanism | Source evidence |
|---|---|---|
| **Index storage location** | `COLGREP_DATA_DIR` env var | `index/paths.rs:67-78` (`get_colgrep_data_dir` checks `COLGREP_DATA_DIR` first, falls back to `dirs::data_dir()/colgrep/indices`) |
| **Config isolation** | *also* `COLGREP_DATA_DIR` — config path is derived as `data_dir.parent()/config.json` | `config.rs:486-493` (`get_config_path` = `get_colgrep_data_dir().parent().join(CONFIG_FILE)`). Setting `COLGREP_DATA_DIR` to `<router>/colbert/indices` ⇒ config lands at `<router>/colbert/config.json`, fully decoupled from the user's `~/.config/colgrep` / `%APPDATA%\colgrep`. |
| **Model (skip HF download)** | `--model <local-dir>` (a path that `exists() && is_dir()` is used verbatim, no HF call) | `model.rs:27-30` (local-path short-circuit before the `hf-hub` download) |
| **ONNX Runtime (skip GH download)** | `ORT_DYLIB_PATH` env var (checked first; if valid, used directly) | `onnx_runtime.rs:133-148` |
| **Force CPU** | `--force-cpu` flag OR `COLGREP_FORCE_CPU=1` | `cli.rs:443-445`, `onnx_runtime.rs:61-70` |
| **Machine-readable output** | `--json` (prints `serde_json::to_string_pretty(&Vec<SearchResult>)`) | `cli.rs:303`, `search.rs:663-664` |
| **No ANSI / agent-safe** | `--color never` | `cli.rs:435-441` |
| **Result count** | `-k <n>` / `--results <n>` | `cli.rs:295-296` |
| **Semantic/keyword balance** | `--alpha <f32>` (0=keyword, 1=semantic) OR `COLGREP_ALPHA` | `cli.rs:373-375`, `config.rs:413-416` |
| **Auto-confirm large repos** | `-y` / `--yes` (skips the >10K-unit prompt) | `cli.rs:429-431` |

**Config-isolation corollary (important):** because `COLGREP_DATA_DIR` *also*
relocates `config.json`, a user's existing `~/.config/colgrep/config.json`
(e.g. `--int8`, a custom `set-model`, a non-default `alpha`) **cannot** alter
router behavior. Belt-and-suspenders: pass every behavior-affecting setting as
an explicit flag on each invocation (`--model`, `--alpha`, `-k`, `--color
never`, `--json`) so even a router-owned `config.json` drift can't change
results.

---

## 3. Prep & supply-chain safety (download + verify, mirroring `toolbelt`)

github-router provisions **three** artifacts. For each: a SHA256-pinned,
size-capped, timeout-bounded download into the router data dir, verified BEFORE
use — the exact pattern in `src/lib/toolbelt/provision.ts` +
`src/lib/toolbelt/manifest.ts`. **colgrep itself does zero checksum
verification** on its own HF-model and ORT downloads (read the source: `model.rs`
trusts `hf-hub`; `onnx_runtime.rs:578-586` `ureq::get(...).into_reader()` with no
digest check) — so pre-supplying both is not just convenience, it **closes a
supply-chain hole colgrep leaves open**.

### 3a. The colgrep binary — prebuilt release, SHA-pinned

**v1.5.2 ships prebuilt binaries with `.sha256` sidecars** (cargo-dist), so we
download a known-good binary; we do NOT build from source (no Rust toolchain on
a fresh Windows box). Assets:

| `platform-arch` key | Asset | Archive |
|---|---|---|
| `win32-x64` | `colgrep-x86_64-pc-windows-msvc.zip` | zip |
| `darwin-arm64` | `colgrep-aarch64-apple-darwin.tar.xz` | **tar.xz** |
| `darwin-x64` | `colgrep-x86_64-apple-darwin.tar.xz` | **tar.xz** |
| `linux-x64` | `colgrep-x86_64-unknown-linux-gnu.tar.xz` | **tar.xz** |

URL shape:
`https://github.com/lightonai/next-plaid/releases/download/v1.5.2/<asset>`.

- **Pinning:** hardcode the SHA256 (read from the published `.sha256` sidecar at
  manifest-generation time, NOT fetched at runtime) into a new
  `src/lib/colbert/manifest.ts` mirroring `toolbelt/manifest.ts`'s
  `ToolAsset { url, sha256, archive }` shape. A `scripts/gen-colbert-manifest.ts`
  (mirror `gen-toolbelt-manifest.ts`) regenerates on re-pin.
- **Windows is `.zip`** → the existing `extractZipMember` in
  `toolbelt/extract.ts` works as-is. **macOS/Linux are `.tar.xz`** → the
  toolbelt's `extractTarGzMember` only does **gzip** (`gunzipSync`); xz is not in
  Node's `zlib`. Build note: add an `xz` decode path (either a tiny pure-JS
  lzma/xz inflater, or shell out to the system `tar`/`xz` which is universally
  present on macOS/Linux — POSIX-only path, never hit on the Windows primary
  target). Keep the regular-files-only extraction guard from
  `extract.ts` (rejects symlink/hardlink/device entries).
- **Storage:** `<router>/colbert/bin/colgrep[.exe]` + `.sha256` sidecar.
  Idempotent re-provision: present + sidecar-matches → skip (same logic as
  `provisionTool`).

> **Rejected alternative:** colgrep's own `--install-*`/`update` and the
> `colgrep-installer.ps1`/`.sh` scripts. Those install globally, write to the
> user's PATH, and run unverified `irm | iex`. github-router must own the binary
> in its data dir and never run a remote script.

### 3b. The ColBERT model — HF download, per-file SHA-pinned, local-dir handoff

The model is `lightonai/LateOn-Code-edge` (`model.rs:5`), ModernBERT-based
ColBERT, ~16.8M params. Five required files (`model.rs:8-14`), total **~21 MB**:

| File | Size |
|---|---|
| `model_int8.onnx` | 17.2 MB |
| `tokenizer.json` | 3.58 MB |
| `config.json` | 1.25 kB |
| `config_sentence_transformers.json` | 762 B |
| `onnx_config.json` | 792 B |

**Do NOT let colgrep download the model** (its `hf-hub` path is unverified and
caches under the HF cache dir, outside our control). Instead github-router:
1. Downloads the five files from HuggingFace **at a pinned repo revision**
   (commit SHA, via `https://huggingface.co/lightonai/LateOn-Code-edge/resolve/<rev>/<file>`).
2. Verifies **per-file SHA256** against hardcoded digests.
3. Stores them under
   `<router>/colbert/models/LateOn-Code-edge/<rev>/`.
4. Passes `--model <that-dir>` on every `init`/`search`. `model.rs:27-30` uses a
   local dir verbatim when it exists — **no HF call happens at all.**

This pins both *integrity* (SHA) and *version* (revision), so a model
re-publish upstream can't silently change ranking. Note: colgrep defaults to
FP32 (`model.onnx`, 68 MB) per `settings --fp32` being default; we deliberately
ship **only INT8** (`model_int8.onnx`) and select it. (colgrep's `--int8` toggle
lives in `settings`; since we control the local model dir we simply omit
`model.onnx` so INT8 is the only option present — smaller footprint, faster CPU
inference, the published-recommended edge config.)

### 3c. ONNX Runtime 1.23.0 — GH-release download, SHA-pinned, `ORT_DYLIB_PATH` handoff

colgrep pins ORT **1.23.0** (`onnx_runtime.rs:33`) and auto-downloads the
platform dylib from `microsoft/onnxruntime` GitHub releases
(`onnx_runtime.rs:595-718`) — **with no checksum.** github-router pre-supplies it
the same way:

| `platform-arch` | Archive (from `get_download_info`) | Member |
|---|---|---|
| `win32-x64` | `onnxruntime-win-x64-1.23.0.zip` | `lib/onnxruntime.dll` |
| `darwin-arm64` | `onnxruntime-osx-arm64-1.23.0.tgz` | `lib/libonnxruntime.1.23.0.dylib` |
| `darwin-x64` | `onnxruntime-osx-x86_64-1.23.0.tgz` | `lib/libonnxruntime.1.23.0.dylib` |
| `linux-x64` | `onnxruntime-linux-x64-1.23.0.tgz` | `lib/libonnxruntime.so.1.23.0` |

Base URL: `https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/`.

- SHA256-pin each archive in the manifest. Windows `.zip` → `extractZipMember`;
  macOS/Linux `.tgz` → `extractTarGzMember` (these are **gzip**, unlike the
  colgrep `.tar.xz` — so the existing gzip extractor covers all three POSIX ORT
  archives). Extract the named dylib into
  `<router>/colbert/onnxruntime/1.23.0/cpu/<libname>`. **Note:** the ORT archive
  ships more than one file (versioned dylib, possibly a symlink/companion); on
  Windows the `onnxruntime.dll` may have **dependent DLLs / require a soname
  symlink** on POSIX. Extract whatever the loader needs into the same dir (not
  just the one named member), and on POSIX create the `libonnxruntime.so` →
  `libonnxruntime.so.1.23.0` soname symlink colgrep's `ORT_LIB_NAME` expects.
- Pass `ORT_DYLIB_PATH=<that file>` in the colgrep child env. colgrep validates
  it loads (`is_valid_ort_dylib`) and uses it directly — **but if the path is
  invalid it CLEARS the env and falls through to its own unverified GH download**
  (`onnx_runtime.rs:135-160`). So a broken handoff silently re-opens the
  supply-chain hole. Mitigate: (a) verify the extracted dylib is loadable in the
  **post-provision smoke test** below before advertising semantic as available;
  (b) optionally also block colgrep's network egress for the child (no
  router-controlled flag for this, so the smoke test is the real guard).
- Always pair with `--force-cpu` (and/or `COLGREP_FORCE_CPU=1`): we ship the CPU
  build only, never CUDA/DirectML. Keeps RAM/driver surface minimal and
  deterministic across machines.

### Post-provision smoke test (before advertising `ready`)

After provisioning binary+model+ORT, run ONE cheap colgrep invocation with the
**exact** isolating env (`COLGREP_DATA_DIR`, `ORT_DYLIB_PATH`, `--model <dir>`,
`--force-cpu`) — e.g. `colgrep status <tmp>` or a search against a 1-file fixture
— and confirm it exits 0 and the ORT dylib actually `dlopen`'d. This catches:
ORT MSVC-runtime missing (Windows), missing dependent DLL, glibc/CPU-feature
incompatibility (Linux), macOS quarantine/codesign block, an incomplete model
dir. On smoke-test failure, the capability stays *visible* but every call returns
`status:"failed"` + lexical fallback + an actionable notice — never a hard error,
never colgrep's silent re-download.

### Supply-chain risk register

| Risk | Closed by |
|---|---|
| colgrep binary tampered/republished | hardcoded SHA256 (not runtime-fetched), regular-files-only extraction |
| ORT dylib tampered (colgrep does NO checksum) | github-router pre-supplies SHA-pinned ORT; `ORT_DYLIB_PATH` short-circuits colgrep's unverified downloader |
| HF model swapped under us (colgrep does NO checksum) | per-file SHA + pinned revision; `--model <local-dir>` short-circuits HF entirely |
| Untrusted network at install | size cap (`MAX_DOWNLOAD_BYTES`), timeout, HTTPS-only, `User-Agent` tag — all from `toolbelt/provision.ts` |
| Remote-script install vector (`irm\|iex`, `installer.sh`) | never used; github-router owns the binary in its data dir |
| User `config.json` / env (`COLGREP_ALPHA`, `set-model`) changing results | router-owned `COLGREP_DATA_DIR` relocates config; explicit flags on every call override config |

---

## 4. Index storage & lifecycle

### Where

Router-owned, NOT in the user's repo, NOT in the global `%APPDATA%\colgrep`:

```
~/.local/share/github-router/colbert/
  bin/colgrep[.exe]                         # §3a
  models/LateOn-Code-edge/<rev>/            # §3b (5 files)
  onnxruntime/1.23.0/cpu/<libname>          # §3c
  indices/                                  # === COLGREP_DATA_DIR ===
    <project>-<xxh3(path|model)[:8]>/       # colgrep-owned per-(path,model) dir
      index/        (PLAID vectors + SQLite + metadata.json)
      state.json    (per-file content_hash + mtime; incremental)
      project.json  (canonical path + model id)
      .lock         (fs2 advisory lock, 5s timeout)
    .gh-router-meta/<same-hash>.json        # === ROUTER-OWNED sidecar metadata ===
  config.json                               # colgrep config (isolated here, unused by us)
```

`COLGREP_DATA_DIR=<router>/colbert/indices` makes colgrep key the physical index
by `xxh3(canonical_project_path | model)` (`paths.rs:84-119`) — deterministic,
collision-resistant, and (critically) **keyed by absolute workspace path**, so
"works with ANY workspace" falls out for free: every distinct workspace gets its
own index dir, and queries route to the right one by passing that workspace as
the colgrep search `PATH` arg.

### Staleness — DO NOT key the physical dir by commit, but DO distinguish fresh from stale

colgrep does **incremental** updates: `state.json` stores per-file
`content_hash`+`mtime`, and every `search`/`init` runs a **non-blocking**
`try_index` that re-encodes only changed files (`search.rs:1144-1228`). Keying
the *physical* index directory by git commit/tree hash (as Phase B's staleness
reasoning suggested for a from-scratch index) would force a **full rebuild every
commit** and duplicate the entire PLAID index per commit — pathological. So
**let colgrep own the physical dir (path+model keyed) and let its incremental
updater handle file-level reconciliation.**

**But "incremental updater reconciles" is NOT the same as "results are correct
right now."** Two correctness gaps the design must NOT paper over with an
advisory notice:

1. **Non-blocking update ⇒ a query can run against the OLD index.** When
   `try_index` can't get the lock (a background `init`/`search` holds it), the
   foreground search runs against whatever's on disk — which may predate recent
   edits. Returning `status:"ready"` there is a lie.
2. **Deletions / renames / branch switches.** colgrep's incremental update keys
   on per-file `content_hash`+`mtime`; a file deleted on disk or swapped by a
   branch switch should be removed/replaced in the index, but until that
   reconciliation completes the index can surface **content that no longer exists
   at that path**. A stale hit pointing at a deleted symbol is a correctness
   defect, not a cosmetic one.

**Therefore the tool reports a real freshness state, not just an advisory hint.**
github-router keeps a router-owned metadata sidecar at
`indices/.gh-router-meta/<hash>.json`:

```jsonc
{
  "workspace": "<abs path>",
  "model": "LateOn-Code-edge",
  "modelRev": "<pinned rev>",
  "binarySha": "<colgrep sha>", "ortSha": "<ort sha>",  // full-rebuild trigger on change
  "status": "absent" | "building" | "ready" | "failed",
  "lastIndexedHead": "<git HEAD at last successful index>",
  "lastIndexedDirty": true,                              // working tree had uncommitted changes at index time
  "lastIndexedAt": "<iso>",
  "buildPid": 12345,                                     // owning init PID (lifecycle sweep)
  "ownerInstanceId": "<proxy-run uuid>"                 // ownership check for the boot sweep
}
```

The handler computes a **freshness verdict** per query (cheap git calls via the
Windows-safe runner, all bounded):

- Read current `HEAD` (`git rev-parse HEAD`) and dirty state (`git status
  --porcelain`, capped).
- **`fresh`** ⇔ `status:"ready"` AND current `HEAD == lastIndexedHead` AND
  neither the last index nor the current tree is dirty (or the dirty delta is
  within colgrep's just-completed incremental update — see below). Run semantic
  search; return `status:"ready"`.
- **`stale`** ⇔ `status:"ready"` but `HEAD` moved (branch switch / new commits)
  OR the working tree is dirty since the last index. Here the choice is: (a)
  **bounded-wait** — kick a foreground incremental update with a short budget
  (e.g. 3-5s) and, if it completes, serve `fresh`; or (b) if it can't get the
  lock or exceeds the budget, **degrade to lexical** with `status:"stale"` +
  a notice ("index predates current HEAD; showing lexical results"). The tool
  does NOT silently return possibly-deleted-content semantic hits labeled
  `ready`.
- **`building`/`provisioning`/`absent`/`failed`** → lexical fallback (§6).

Note the non-blocking `try_index` colgrep itself runs on every `search` is a
best-effort *delta* — it helps, but the router-side freshness verdict is what
guarantees we never *label* a stale result as fresh. A **full rebuild** (`colgrep
clear <ws>` then `init`) is forced only when `model`/`modelRev`/`binarySha`/
`ortSha` change (embedding dims or engine changed → index invalid).

> The git checks are advisory *for routing*, not for keying. A non-git workspace
> simply has no `lastIndexedHead`; its freshness verdict falls back to
> `mtime`-based reasoning (was anything under the workspace modified after
> `lastIndexedAt`?), which is exactly colgrep's own incremental signal.

### Build cost / time

First full index of a non-trivial repo is **CPU-bound, multi-second to minutes**
(rayon parallel ONNX sessions, default = CPU count capped 16; `README` indexing).
INT8 + pool-factor-2 keeps the on-disk index ~50% smaller. Subsequent searches
pay only the query encode (tens-to-low-hundreds of ms on CPU) + the incremental
delta. The >10K-code-unit confirmation prompt is auto-skipped with `-y`.

---

## 5. Sidecar lifecycle (clean spin-up / spin-down, never-orphan)

Because invocations are short-lived child processes, the lifecycle problem is
**process tracking + cancellation + boot/exit sweep**, NOT keep-alive. Model it
on the worker-agent lifecycle (PID ledger + boot sweep) and the browser-bridge
cleanup, both of which CLAUDE.md calls out as the precedents.

### Spin-up
- **On demand (search for any workspace):** `ensureColbertReady(workspace)`
  pre-flight (mirrors browser MCP's `ensureBridgeReady`): binary present?
  model present? ORT present? If any missing AND provisioning hasn't completed,
  return a `status: "provisioning"` degradation (NOT an error) and kick the
  background provision. If the index is absent, kick a background `init` and
  return `status: "building"`.
- **On `start` for the cwd (if git repo):** fire-and-forget background `init`
  (§9), exactly like `provisionToolbelt()`.

### Spin-down (never orphan)
Every spawned colgrep child (search or init) is registered in an in-memory
ledger keyed by PID. On proxy exit:
- **SIGINT/SIGTERM handler** kills tracked children. POSIX `process.kill(pid,
  SIGTERM)`; **Windows `taskkill /T /F /PID <pid>`** to kill the whole tree
  (matches `exec.ts:killTree` and the worker-agent's Windows kill). **Kill the
  process GROUP on POSIX** (spawn `init` with `detached`/`setsid` and
  `process.kill(-pgid, SIGTERM)`) so colgrep's rayon worker children don't
  outlive the parent; `taskkill /T` already covers the tree on Windows.
- **Per-call `finally`** kills/awaits the child it spawned (search calls are
  bounded; a wedged search is force-killed at its timeout — see §7).
- **Boot-time sweep** (`ensurePaths`-adjacent, mirror
  `sweepStaleWorktreesAtBoot`): on startup, read `.gh-router-meta/*.json`; any
  `status:"building"` whose `buildPid` is **dead** is a crashed-build escapee →
  reset to `status:"failed"` (do NOT auto-kill: a live PID matching a stale
  `buildPid` may be a **reused PID** belonging to an unrelated process — the
  boot sweep only *reclassifies metadata*, it never sends a kill to a PID from a
  prior boot). Ownership is disambiguated by `ownerInstanceId` (a per-proxy-run
  UUID, mirror the worker-agent's instance gating): only the SIGINT/SIGTERM
  handler — which kills PIDs *this* run actually spawned and tracks in memory —
  ever issues a kill. Stale colgrep `.lock` files are left to colgrep's own 5s
  fs2 timeout (`paths.rs:250-276`); we never delete `.lock` ourselves (racing
  the fs2 lock is unsafe).

### Crash recovery
- colgrep self-heals a **corrupt index**: `search.rs:1196-1222` detects "No data
  to merge" / "Index load failed", clears, and rebuilds. We surface that as a
  one-shot `status:"building"` notice. colgrep also does an **atomic swap** of
  the index dir on rebuild (`index/mod.rs:2120` "Atomic swap: replace old index
  with newly built one"), so a kill mid-build leaves the *old* index intact
  rather than a half-written one — important for the "force-kill on timeout/exit"
  path not corrupting a usable index.
- A **crashed init** (host crash / OOM / SIGKILL) leaves `status:"building"` in
  our sidecar with a dead PID → boot sweep reclassifies; next search re-kicks
  (debounced).
- **Concurrent indexers** (two proxies, same workspace): colgrep's advisory
  `.lock` + non-blocking `try_index` means the second one searches the existing
  index instead of blocking (`search.rs:1181-1188`). No router-side lock needed
  for index correctness, but we still take a `withInstallLock`-style lock around
  the *provision* step (binary/model/ORT download) to avoid duplicate downloads.

### PID/lock/resource hygiene summary
- **No port.** (CLI, not a server — nothing to leak on the network surface.) But
  a CLI sidecar still leaks **processes, temp download dirs, partial model/ORT
  dirs, large stdout buffers, FDs, and CPU/threadpool** if unmanaged — all of
  which the lifecycle + stdout cap + atomic-rename-into-versioned-dirs above
  account for.
- **PID:** in-memory ledger (this run, the only thing ever killed) + `buildPid` +
  `ownerInstanceId` in sidecar meta for cross-process boot *reclassification*.
- **Lock:** colgrep owns the index `.lock` (fs2, 5s timeout, self-stealing);
  github-router owns a provision lock via `withInstallLock` (`O_EXCL` +
  mtime-based stale-stealing already built into `update-lock.ts:30-60` — so a
  crash mid-provision doesn't wedge provisioning forever). Partial downloads land
  in a temp dir and are atomically renamed into a **versioned** artifact dir
  (`models/<name>/<rev>/`, `onnxruntime/<ver>/`) so a failed upgrade never
  poisons the current install.

---

## 6. MCP tool surface

One tool, under the existing **`search`** group (joins `code` and `web`):
`mcp__search__semantic_search` (wire `toolNameHttp: "semantic_search"`). Shape
per the `NonPersonaMcpTool` contract (`peer-mcp-personas.ts:619-675`): `{
toolNameHttp, group, description, inputSchema, capability, handler }`.

### Schema (ruthlessly minimal, per CLAUDE.md surface rule)

```jsonc
inputSchema: {
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    query:     { type: "string", description: "Natural-language intent, e.g. 'where do we validate JWT expiry' or 'retry/backoff around the upstream fetch'. Semantic — finds code by meaning even when the words don't appear literally." },
    workspace: { type: "string", description: "Absolute path to the repo/subtree to search. Defaults to the proxy launch cwd. Must be absolute." },
    limit:     { type: "integer", description: "Max results (default 15)." },
    pattern:   { type: "string", description: "Optional regex pre-filter (colgrep -e): grep first, then rank the matches semantically. Use to scope a semantic ranking to e.g. async fns." }
  }
}
```

(No `alpha`/`pool-factor`/`model` knobs exposed — fixed router defaults; per the
surface-minimality rule, a knob that muddies the signal without a clear "what
would the model do with this" answer is cut. `pattern` stays because hybrid
grep-then-rank is a genuine capability the model can act on.)

### Returns (trimmed — NEVER raw colgrep JSON)

colgrep `--json` emits `Vec<{ unit: CodeUnit, score: f32 }>` where `CodeUnit`
(`parser/types.rs:116-155`) carries **the full source code + all 5 analysis
layers** (calls, called_by, complexity, variables, imports, …). Forwarding that
verbatim would blow the model's context. The handler trims to:

```jsonc
{
  "status": "ready" | "stale" | "building" | "provisioning" | "absent" | "failed",
  "results": [
    { "file": "<rel>", "line": 42, "endLine": 88, "name": "verifyJwt", "score": 0.83, "snippet": "<signature + representative lines>" }
  ],
  "source": "semantic" | "lexical",            // which engine produced `results`
  "notice": "<present only when actionable>"   // e.g. "index building; showed lexical fallback", "index predates current HEAD"
}
```

`snippet` = the unit signature + a few representative lines (use colgrep's
non-`-c` compact `filepath:lines` output, or derive from `unit.signature` +
first lines of `unit.code`), NOT the full `unit.code`. `source` is explicit so
the model knows whether it got semantic or lexical hits without inferring from
`status`.

**Output handling (defense against the full-`CodeUnit` payload):** even though
the handler trims to the 6 fields above, colgrep's stdout carries the **full
source + analysis layers** for every hit, which can be large. So: cap the child
stdout buffer with a hard byte limit (reuse `MAX_STDOUT_BYTES` from
`code-search.ts`), reject + fall back to lexical if exceeded, pass a modest
default `-k` (15), and **never log raw colgrep stdout/stderr** (it embeds source
code — a telemetry-leak vector). Parse failures (truncated/garbage JSON) →
`status:"failed"` + lexical fallback, not a throw.

### Graceful degradation (the load-bearing reliability property)

The tool **never returns an MCP error for a missing/building/stale index.** The
routing decision is made by a **deterministic router-side preflight**, NOT by
parsing colgrep's stderr (string-matching "index is being built" across colgrep
versions/locales is brittle — the critic's finding). The preflight checks, in
order, before deciding whether to spawn colgrep at all:

1. **Capability/provision:** binary+model+ORT present? If not → `provisioning`,
   kick provision, lexical fallback.
2. **Router-owned state:** read `.gh-router-meta/<hash>.json`. If
   `status:"building"` (a tracked `init` is live) OR no completed index marker
   (`index/metadata.json` absent on disk) → do **NOT** spawn a foreground
   colgrep (it would contend the lock or trigger a second blocking build) →
   `building`/`absent`, lexical fallback.
3. **Freshness verdict** (§4): `fresh` → semantic; `stale` → bounded-wait then
   semantic, else lexical with `status:"stale"`.

Only when the preflight says "ready + completed-index-on-disk + fresh (or
freshened within budget)" does the handler spawn `colgrep search`. A nonzero
exit / unparseable output from that spawn is classified as
`status:"failed"` + lexical fallback (with stderr **truncated and never logged
raw**) — we never trust the exact error text.

| State | Behavior |
|---|---|
| `ready` (preflight: completed index on disk, fresh) | run `colgrep search --json`, return trimmed semantic hits, `source:"semantic"`, `status:"ready"` |
| `stale` (HEAD moved / tree dirty since index) | bounded foreground incremental update (3-5s); if freshened → semantic; else lexical, `status:"stale"`, `source:"lexical"`, notice |
| `building` (tracked `init` live, no completed index yet) | lexical `code_search` on the SAME query, `status:"building"`, `source:"lexical"`, notice ("semantic available shortly") — do NOT spawn a competing colgrep |
| `provisioning` (binary/model/ORT not yet downloaded) | kick provision, lexical fallback now, `status:"provisioning"` |
| `absent` (never indexed; new on-demand workspace) | kick a **debounced** background `init` (one per workspace+model), lexical fallback now, `status:"absent"` |
| `failed` (colgrep nonzero exit / parse fail / dlopen fail) | lexical fallback, `status:"failed"`, notice with failure class (truncated) |

`isError:true` is reserved for **input-shape** failures only (missing/relative
`workspace`, empty `query`) — mirroring the `stand_in` / worker-tool invariant
that protocol-valid degradations are NOT errors.

**Self-contention avoidance (critic finding #3):** the preflight's rule "if a
tracked `init` is live OR no completed index exists, don't spawn a foreground
colgrep" is what prevents the start-up `init` and an immediate user query from
fighting over the lock and triggering redundant builds. On-demand `init` is
**debounced per (workspace, model)** so repeated first-queries don't spawn N
builders. A global cap bounds concurrent colgrep processes regardless.

### Capability gate — `semanticSearchEnabled()`

New predicate in `src/lib/mcp-capabilities.ts`, mirroring
`browserToolsEnabled()`. Returns true iff BOTH:
1. **Opt-in:** `--semantic-search` flag (on `start`/`claude`/`codex`) OR
   `GH_ROUTER_ENABLE_SEMANTIC_SEARCH=1`. (Opt-in because it provisions ~60-80 MB
   and runs a native binary — same posture as `--browse`.)
2. **Platform supported:** a prebuilt colgrep asset + ORT archive exist for the
   running `platform-arch` (i.e. `manifest` has an entry). NOT gated on "already
   downloaded" — gating on download would hide the very tool whose first call
   triggers provisioning. The pre-flight handles not-yet-downloaded by returning
   `status:"provisioning"` + lexical fallback.

Gate fires symmetrically at `tools/list` and `tools/call` (drop + -32601),
exactly like the other capability tags. Add `"semantic_search"` to the
`capability` union in `NonPersonaMcpTool`.

> **Why one tool, not folding into `code`:** `code` is the in-proc, per-call,
> zero-state lexical path and must stay that way (it's the fallback). A separate
> tool keeps the lexical guarantee intact and lets the description steer the
> model to semantic only for NL-intent queries (§8).

---

## 7. Reliability, resource bounds, Windows correctness

### Works with ANY absolute workspace
- `workspace` is absolute-only, enforced at the MCP boundary (mirror
  `runWorkerToolCall`'s absolute-only check) — a relative path is an `isError`
  input failure, never silently resolved against `process.cwd()`.
- Pass the workspace as the colgrep search `PATH` arg; colgrep's
  `find_index_for_project` / `find_parent_index` (`paths.rs:123-214`) route to
  the correct per-workspace index, including the **parent-index reuse** case (a
  subdir of an already-indexed repo searches the parent index).

### Resource bounds (the sidecar's RAM/CPU)
- **CPU:** cap colgrep's parallel encoding sessions via `settings --parallel
  <n>` written into our isolated `config.json`, or accept the default (CPU count,
  max 16). Recommend capping to ~half the cores for the background `init` so the
  build doesn't starve the user's machine; full cores fine for a one-shot search
  encode.
- **RAM:** INT8 model ~17 MB resident + the memory-mapped PLAID index (mmap, so
  it's page-cache-backed, not committed RSS) + ONNX session arenas. Bounded and
  modest on CPU; no GPU memory. A single search process is well under a few
  hundred MB.
- **Wall-clock:** each `search` child gets a **hard timeout** (recommend ~30s;
  the query encode + incremental delta should be sub-second to seconds — a 30s
  ceiling catches a pathological re-index triggered by a huge uncommitted diff).
  On timeout, force-kill (`taskkill /T /F` on Windows) and fall back to
  `code_search` with a `notice`. The `init` background build gets a generous cap
  (e.g. the worker-agent's 30-min wall-clock) and is non-blocking regardless.
- **Inflight slot:** the `semantic_search` call acquires ONE slot from the
  shared `MAX_INFLIGHT_TOOLS_CALL=8` semaphore (`src/lib/mcp-inflight.ts`), after
  the pre-flight, before spawn — same ordering invariant as `predictedTooLong` /
  `ensureBridgeReady` (pre-flight BEFORE slot acquisition so a reject can't leak
  a slot). The background `init` does NOT take a slot (it's not operator
  traffic; it's provisioning).

### Windows correctness (primary deployment target)
- **The managed colgrep binary is a native `.exe`, not a `.cmd` shim**, so we do
  NOT route it through `buildExecInvocation`'s Windows `shell:true` path. That
  path calls `quoteWinArg`, which **throws on `%`** (`exec.ts:140-146`) — and a
  workspace path can legally contain `%` (and `&`, `(`, `)`, …). **Build
  requirement:** add a native-executable runner to `exec.ts` — e.g.
  `runManagedExeCapture(absExe, args, opts)` — that on Windows uses `spawn(absExe,
  args, { shell: false, windowsHide: true })` (CreateProcess resolves `.exe`
  directly, no cmd.exe, no metacharacter hazard, no `%` refusal) while keeping
  the timeout + `taskkill /T /F` tree-kill. POSIX is already `shell:false`. This
  is what makes "ANY workspace" actually hold on Windows.
- **Index path on Windows:** `%LOCALAPPDATA%`-class concern is avoided — we force
  `COLGREP_DATA_DIR` into the router data dir (`~/.local/share/github-router`
  resolves under the user profile on Windows via `os.homedir()`), so we never
  touch the global `%APPDATA%\colgrep`.
- **xz extraction is POSIX-only** (Windows asset is `.zip`), so the xz code path
  (§3a) never runs on the primary target.
- **All child spawns** (search, init, the eventual kill) honor the Windows-safe
  patterns; CI must include a `windows-latest` job exercising a provision +
  index + search round-trip on a fixture repo. The `runManagedExeCapture` runner
  must be tested against a workspace-path matrix: spaces, `%`, `!`, `^`, `&`,
  non-ASCII/Unicode, trailing dot/space, UNC (`\\server\share`), long paths
  (>260, needing `\\?\`), and non-ASCII usernames. `shell:false` removes the
  metacharacter hazard, but long-path / UNC / `\\?\` handling is orthogonal and
  must be verified, not assumed.
- **ORT DLL resolution on Windows:** `ORT_DYLIB_PATH` tells colgrep WHICH dll to
  load, but if `onnxruntime.dll` has dependent DLLs, Windows resolves THOSE via
  its own search order. Keep all ORT files co-located in one dir and (if needed)
  prepend that dir to the child's `PATH` so dependent-DLL resolution succeeds.
  This is covered by the post-provision smoke test (§3c).

---

## 8. Honest cost/benefit — where semantic beats lexical (and where it doesn't)

This drives the **tool description** so the model routes queries correctly.

| Query shape | Lexical `code_search` (ripgrep + BM25F + tree-sitter) | `semantic_search` (ColBERT + FTS5 + RRF) |
|---|---|---|
| Exact symbol: "where is `verifyJwt` defined", "callers of `Foo`" | **Use this.** Exact, sub-10ms, stateless, tree-sitter boosts defs. | No edge; slower; adds index dependency. |
| NL intent: "auth middleware", "db connection pooling", "retry/backoff logic" | Weak when the literal words aren't in the code. | **Use this.** Genuine semantic recall over prose/intent — colgrep's published Semble NDCG@10 ≈0.85 is exactly this regime. |
| Hybrid "regex-narrow then rank by relevance" ("async fns ranked by error handling") | Not a single op. | Native (`-e` pre-filter → semantic rank). A capability the lexical path lacks. |

**Description steer (draft):** *"Semantic code search by MEANING, not text. Best
for natural-language intent queries where the literal keywords may not appear
('where do we rate-limit', 'auth token refresh'). For exact symbol lookup
('where is X defined', 'callers of Y') prefer `code` (lexical) — it's faster and
exact. Returns a status field; while the index builds it transparently falls
back to lexical results."*

### Cost ledger (be skeptical about a fresh Windows box)
- **Build complexity:** a new `src/lib/colbert/` module (provision, index-store,
  runner, lifecycle) + manifest + one MCP tool + one gate + one `exec.ts` runner
  + an xz path (POSIX). Moderate — but every piece has a direct precedent
  (toolbelt, worker-agent lifecycle, browser pre-flight, non-persona tool).
- **Disk:** colgrep binary (single-digit-to-low-tens MB) + INT8 model ~21 MB +
  ORT dylib (~15-40 MB) + per-repo index (corpus-proportional, ~50% reduced by
  INT8+pooling). Rough fixed cost ~60-80 MB before any index.
- **First-run latency:** provision downloads (~60-80 MB over the network) + first
  full index (multi-second to minutes, CPU-bound). **This is the headline cost**
  and the reason indexing-on-start + transparent lexical fallback are
  non-negotiable — the user must never *wait* on it.
- **Per-query latency:** tens-to-low-hundreds of ms on CPU vs ripgrep's <10ms.
  Acceptable for an opt-in NL-intent tool; would NOT be acceptable as the default
  `code` path (which is why we keep them separate).
- **Fresh-Windows reliability honesty:** the chain is binary-download →
  sha-verify → ORT-download → sha-verify → model-download → sha-verify → native
  dlopen of ORT → ONNX session init → index build. Each link can fail
  (network, AV quarantine of an unsigned `.exe`, ORT MSVC-runtime dependency).
  **Every failure must degrade to lexical, never to an error**, and surface a
  `notice` the user/model can act on. The MSVC-runtime dependency of the ORT DLL
  on Windows is the one external prerequisite we can't fully control — flag it in
  the `notice` if dlopen fails ("ONNX Runtime failed to load; semantic search
  unavailable, using lexical").

---

## 9. Indexing-on-start hook

Mirror `provisionToolbelt()`'s fire-and-forget call site in
`src/start.ts` / `src/claude.ts` / `src/codex.ts` (after `setupAndServe`, like
`runSelfUpdate`). New `provisionAndIndexColbert()`:

1. Gate: `semanticSearchEnabled()` — bail if opt-out.
2. Provision (binary/model/ORT) under a provision lock; best-effort, never throws
   to the launcher (toolbelt pattern).
3. **git-repo detection** for the launch cwd: `git rev-parse --is-inside-work-tree`
   (via the Windows-safe runner). If not a git repo → skip the auto-index (the
   user can still trigger on-demand for any workspace via the tool).
4. If git repo and index `absent`/`stale` → spawn a background, tracked `colgrep
   init -y --model … --force-cpu <cwd>`, register `buildPid` in sidecar meta,
   set `status:"building"`. **Non-blocking** — the launcher proceeds; the server
   is already listening.
5. **On-demand for non-cwd workspaces:** any `semantic_search(workspace=X)` for
   an unindexed X kicks the same background `init` and returns lexical fallback
   meanwhile (§6).

This matches the user's requirement: index-on-`start` for the current git
workspace, on-demand for others, always background, never blocking launch.

---

## 10. File-level build map (no shared-file collisions)

| New file | Mirrors | Purpose |
|---|---|---|
| `src/lib/colbert/manifest.ts` | `toolbelt/manifest.ts` | SHA-pinned URLs for binary + ORT + model files, per `platform-arch` |
| `src/lib/colbert/provision.ts` | `toolbelt/provision.ts` | download+verify+extract binary/ORT/model into data dir; provision lock |
| `src/lib/colbert/index-store.ts` | (new) | sidecar-meta read/write, status, staleness decision, `COLGREP_DATA_DIR` path derivation |
| `src/lib/colbert/runner.ts` | worker-agent spawn | spawn `colgrep search/init` with isolating env + flags; parse `--json`; trim to MCP shape |
| `src/lib/colbert/lifecycle.ts` | `worker-agent/lifecycle.ts` | PID ledger, SIGINT/SIGTERM kill, boot sweep |
| `scripts/gen-colbert-manifest.ts` | `gen-toolbelt-manifest.ts` | regenerate SHA pins |
| **Edits (lead-owned integration files):** | | |
| `src/lib/exec.ts` | — | add `runManagedExeCapture` (native-exe, `shell:false`, `%`-safe) |
| `src/lib/peer-mcp-personas.ts` | — | add `semantic_search` to `NON_PERSONA_MCP_TOOLS` + `"semantic_search"` to `capability` union |
| `src/lib/mcp-capabilities.ts` | — | add `semanticSearchEnabled()` |
| `src/routes/mcp/handler.ts` | — | wire the capability into list/call gating |
| `src/start.ts` / `src/claude.ts` / `src/codex.ts` | — | `--semantic-search` flag + `provisionAndIndexColbert()` call site |
| `src/lib/toolbelt/extract.ts` | — | add `extractTarXzMember` (POSIX-only xz path) |

---

## 11. Phased build plan

1. **Spike (de-risk the chain + MEASURE latency).** Manually: download v1.5.2
   colgrep + ORT 1.23.0 + the 5 model files; run `COLGREP_DATA_DIR=<tmp>
   ORT_DYLIB_PATH=<dylib> colgrep search --json --color never --force-cpu --model
   <dir> "auth" <repo>` on Windows AND macOS. Confirm the **handoff** facts:
   (a) `--model <local-dir>` skips HF, (b) `ORT_DYLIB_PATH` skips GH download,
   (c) JSON shape == `Vec<{unit,score}>`, (d) config lands at
   `<COLGREP_DATA_DIR>/../config.json`, (e) a `%`/`&`/space-containing workspace
   path works via `shell:false`, (f) an INVALID `ORT_DYLIB_PATH` does NOT
   silently fall back to a network download (confirm the smoke-test guard is
   needed), (g) branch-switch + file-deletion: index a repo, `git checkout` a
   branch that deletes a file, search — does a stale hit for the deleted symbol
   appear before/after the incremental update? (validates the §4 freshness
   verdict).
   **Then MEASURE** (the load-bearing gate): warm-query p50/p95 after a prior
   query (cold ORT/model load excluded), cold first-query, query-while-`init`-
   holds-lock, large-repo-with-existing-index, and Windows process-startup
   overhead. **Gate: if any of a-g fails, STOP. If warm p95 exceeds the agreed
   budget (propose ≤1.5s warm p95 on a mid repo), DO NOT proceed with the
   per-invocation default — pivot to the freshness-predicate-default posture
   (§1) and/or pursue an upstream `serve` mode before shipping.**
2. **Prep/download (manifest + provision).** `colbert/manifest.ts` +
   `provision.ts` + `gen-colbert-manifest.ts` + the xz extractor. SHA-pinned,
   idempotent, background, never-throws. Tests mirror the toolbelt tests.
3. **Index store + staleness.** `index-store.ts` + the `COLGREP_DATA_DIR` wiring
   + sidecar meta + rebuild-on-engine-change logic.
4. **Sidecar (runner + lifecycle).** `runner.ts` (`exec.ts` native runner,
   `--json` parse, trim) + `lifecycle.ts` (PID ledger, kill, boot sweep). Race
   tests: cancel mid-search, kill-on-exit, dead-PID boot sweep.
5. **MCP tool + gate.** `semantic_search` in `NON_PERSONA_MCP_TOOLS`,
   `semanticSearchEnabled()`, handler gating, degradation matrix, lexical
   fallback. Gate tests mirror `browser-mcp-gate.test.ts`.
6. **Start-hook.** `--semantic-search` flag + `provisionAndIndexColbert()` at the
   `start`/`claude`/`codex` call sites; git-repo detection; non-blocking.
7. **Docs + CI.** Probe rows where applicable; `windows-latest` round-trip test
   (provision→init→search→fallback); update CLAUDE.md + a `docs/semantic-search.md`.

Each phase is independently shippable behind the off-by-default flag, so partial
landing never regresses existing behavior.

---

## 12. Risks & mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Per-query cold-start latency** — no warm process; every call re-loads ORT + builds an ONNX session + loads the model + mmaps the index (page cache does NOT eliminate session/model init) | **High** | Measured-warm-p95 GO gate in the spike (§11.1, §13.1); separate opt-in tool (never the default path); degradation routes building/stale/slow to lexical; if budget fails, pivot to freshness-predicate-default + upstream `serve` |
| 2 | First-run setup latency: ~60-80 MB download + minutes-long full index on a fresh box | High | Background provision + index-on-start; tool degrades to lexical with `status`/`notice`; user never waits |
| 3 | Stale semantic hit after branch switch / file deletion (non-blocking incremental update ⇒ query can hit old index) | **High** | Router-side **freshness verdict** (§4): HEAD/dirty check → `fresh` serves semantic, `stale` does bounded-wait-then-lexical; never label possibly-deleted content as `ready` |
| 4 | Windows `%`/metachar in workspace path breaks `quoteWinArg` | High | Native-exe `shell:false` runner (`runManagedExeCapture`) — colgrep is a real `.exe`, bypass cmd.exe; tested against the path-edge matrix (§7) |
| 5 | colgrep does NO checksum on its own ORT/model downloads; an invalid `ORT_DYLIB_PATH` silently re-triggers its download | High | Pre-supply both SHA-pinned via `ORT_DYLIB_PATH` + `--model <local-dir>`; **post-provision smoke test** (§3c) confirms the handoff before advertising `ready` |
| 6 | Brittle fallback classification (stderr string-match across colgrep versions) | Med | Deterministic router-side **preflight** (§6) decides routing from on-disk index markers + router state, NOT colgrep stderr; unknown spawn failures → `failed` + lexical |
| 7 | ORT DLL needs MSVC runtime / dependent DLLs on a bare box; dlopen fails | Med | Smoke test detects it; co-locate ORT files + PATH-prepend their dir; degrade to lexical + actionable `notice` |
| 8 | `.tar.xz` not decodable by Node `zlib` (macOS/Linux assets) | Med | xz path (pure-JS or system `tar`); Windows (`.zip`) unaffected — primary target safe |
| 9 | Orphaned `colgrep init` + rayon children after host crash | Med | `buildPid`+`ownerInstanceId` boot **reclassify** (never kill a reused PID from a prior boot); POSIX process-group kill + Windows `taskkill /T` for THIS run's children |
| 10 | Self-contention: start-up `init` vs immediate user query fighting the lock; repeated first-queries spawning N builders | Med | Preflight skips foreground colgrep while a tracked `init` is live / no completed index; on-demand `init` **debounced** per (workspace,model); global concurrent-colgrep cap |
| 11 | Full index per commit (if mis-keyed) | Med | Do NOT key physical dir by commit; rely on colgrep incremental updater; commit drives freshness verdict only |
| 12 | Full-`CodeUnit` JSON payload (source + analysis) bloats memory / leaks source to logs | Med | Hard stdout byte cap + reject→lexical; trim to 6 fields; **never log raw stdout/stderr** |
| 13 | Stale provision lock after crash mid-download | Low | `withInstallLock` already does mtime-based stale-stealing (`update-lock.ts:30-60`); partial downloads in temp dir, atomic-rename into versioned artifact dirs |
| 14 | Concurrent indexers (two proxies, same repo) | Low | colgrep's fs2 `.lock` + non-blocking `try_index` handle it; provision lock prevents dup downloads |
| 15 | User `config.json`/`COLGREP_ALPHA` alters results | Low | `COLGREP_DATA_DIR` relocates config to router dir; explicit flags override per call |
| 16 | Upstream re-pins model/binary → ranking drift | Low | Pinned revision + SHA; full rebuild forced only on intentional engine/model digest change |
| 17 | AV quarantines the unsigned colgrep `.exe` on Windows | Low | Smoke test surfaces it; degrade to lexical + `notice`; document the allowlist step |

---

## 13. GO / NO-GO

**GO, with conditions.** The original NO-GO rested on three objections —
persistent index, model download, native ONNX — all of which the user's opt-in
converts into github-router responsibilities the existing patterns already
discharge (toolbelt provision, worker-agent lifecycle, browser pre-flight). The
investigation found that colgrep exposes **every** control surface we need as a
plain env var or flag (`COLGREP_DATA_DIR` for index+config, `--model
<local-dir>` and `ORT_DYLIB_PATH` to bypass its unverified downloads, `--json`
for parsing, `--force-cpu` for determinism), prebuilt SHA-sidecar'd release
binaries exist for all target platforms, and the absence of a daemon mode makes
the lifecycle *simpler* than the browser bridge, not harder.

**Conditions (must hold or downgrade to NO-GO):**
1. **Spike phase passes a-g AND meets the warm-latency budget** (§11.1) on
   Windows AND macOS — especially the `--model <local-dir>` / `ORT_DYLIB_PATH`
   bypass, the `%`-in-path `shell:false` spawn, and the branch-switch/deletion
   freshness check. If colgrep ignores the local-dir or env handoffs, the
   no-unverified-download guarantee breaks → NO-GO. **If warm p95 exceeds the
   agreed budget, the per-invocation default is NO-GO** — pivot to
   freshness-predicate-default and/or an upstream `serve` mode before shipping.
2. **Tool NEVER errors on missing/building/stale index, and NEVER labels a stale
   result `ready`** — lexical fallback + an honest `status`/`source`/freshness
   verdict is mandatory. A version that 500s on a not-ready index, OR returns
   possibly-deleted-content semantic hits as `ready` after a branch switch, fails
   the "works reliably with ANY workspace" requirement.
3. **Off by default** (`--semantic-search` opt-in) and **never blocks launch** —
   provision/index are background, best-effort, swallow-to-log.
4. **`windows-latest` CI** green on a provision→init→search→fallback round-trip
   before merge (primary-target gate per CLAUDE.md).

If 1-4 hold, this is a clean, reliable, fully-managed semantic-search capability
that complements (never replaces) the lexical `code` tool.

---

## Appendix — primary-source citations

- No daemon: `colgrep/src/cli.rs:452-719` (command set) + whole-crate scan for
  server/listener keywords (only incidental hits).
- Index+config dir override: `index/paths.rs:67-78` (`COLGREP_DATA_DIR`),
  `config.rs:486-493` (config = `data_dir.parent()/config.json`).
- Local-model bypass: `model.rs:27-30`. Required files: `model.rs:8-14`.
- ORT bypass + pin + (unverified) download: `onnx_runtime.rs:33,133-160,578-718`.
- Search JSON + incremental reindex + corruption self-heal:
  `commands/search.rs:663-664,1144-1248`. Result shape: `index/mod.rs:2773-2778`
  (`SearchResult{unit,score}`), `parser/types.rs:116-155` (`CodeUnit`).
- Release assets v1.5.2 (prebuilt + `.sha256` sidecars):
  github.com/lightonai/next-plaid/releases.
- Model sizes (INT8 17.2 MB, tokenizer 3.58 MB, FP32 68 MB):
  huggingface.co/lightonai/LateOn-Code-edge.
- github-router precedents: `src/lib/toolbelt/{provision,manifest,extract}.ts`,
  `src/lib/exec.ts`, `src/lib/paths.ts`, `src/lib/update-lock.ts`,
  `src/lib/self-update.ts`, `src/lib/peer-mcp-personas.ts` (`NonPersonaMcpTool`,
  `GROUP_META`), `src/lib/mcp-capabilities.ts`, `docs/browser-mcp-design.md`.
