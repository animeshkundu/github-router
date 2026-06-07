# colgrep investigation — fit against github-router `code_search`

**Target:** `colgrep` in [`lightonai/next-plaid`](https://github.com/lightonai/next-plaid/tree/main/colgrep) — "Semantic code search powered by ColBERT."
**Question:** Is colgrep useful for github-router's `code_search`, and does it fit our hard constraints? Verdict on (a) standalone MCP tool and (b) `code_search` integration.
**Method:** Read the actual Rust source (`/tmp/colgrep-inv/colgrep/`, depth-1 clone), supplemented by the model card on HuggingFace. Adversarial lens: the project is a stateless, Windows-first, in-process Node/Bun proxy that forbids persistent per-workspace state, heavy runtime deps, model downloads, and GPU requirements in the proxy process.

---

## TL;DR verdicts

- **(a) Standalone MCP tool — NO-GO** (qualified). colgrep has **no MCP server**; it is a CLI agents shell out to, and it only works against a **pre-built persistent embedding index** (`colgrep init`) plus a downloaded ~17M-param ColBERT model and a native ONNX Runtime `.dll`/`.so`/`.dylib`. Wrapping it would mean a heavyweight, stateful, side-effectful tool that the proxy cannot guarantee is installed or indexed. Only conceivable as an explicit, user-opt-in "I already installed colgrep and ran `init`" passthrough — which is exactly what colgrep's own `--install-claude-code` already does without us.
- **(b) `code_search` integration — NO-GO** (hard). colgrep is fundamentally index-first and runtime-heavy: it **persists a per-workspace PLAID vector index + SQLite metadata**, **downloads a model from HuggingFace**, and **dlopen's a native ONNX Runtime**. Every one of those violates a non-negotiable of `code_search` (in-process, per-call, zero persistent per-workspace state, zero model download, zero heavy native dep). There is **no index-free / per-call path** in the code.

One correction to the brief's worst-case framing: colgrep is **not** a Python/torch/GPU misfit. It is a self-contained **Rust** binary; inference runs **on CPU by default**; GPU (CUDA/CoreML/DirectML) is strictly opt-in; **Windows is a first-class target**. It is less bad than feared on the runtime axis — but it still fails on **persistent state + model download + native ONNX**, which are the binding constraints.

---

## What colgrep is + mechanism (source evidence)

A single Rust CLI binary (`colgrep/Cargo.toml` → `[[bin]] name = "colgrep"`) that does hybrid **ColBERT late-interaction semantic search + FTS5 trigram keyword search**, fused with Reciprocal Rank Fusion. Pipeline (`README.md:378-473`):

1. **Parse** with tree-sitter into code units (functions/methods/classes/constants/raw blocks) — 25 languages.
2. **Analyze** 5 layers (AST signature/params, call graph, control flow, data flow, imports).
3. **Build structured text** per unit (signature + params + calls + docstring + code + normalized path).
4. **Encode** with ColBERT → ~300 token-level vectors of dim 128 per unit; query-time **MaxSim** scoring.
5. **Index with PLAID** — product-quantized (2/4-bit), memory-mapped, incremental.
6. **Search** — encode query → SQLite pre-filter → optional regex pre-filter → ColBERT MaxSim → FTS5 BM25 → RRF fuse (alpha=0.75 semantic) → demote tests → representative-line finder.

**Model:** `model.rs:5` `DEFAULT_MODEL = "lightonai/LateOn-Code-edge"`. Per the HF card: **~16.8M params, ModernBert-based ColBERT**, F32 ONNX ≈67MB; colgrep downloads the **INT8 quantized** `model_int8.onnx` by default (`model.rs:8-14` `REQUIRED_FILES`), ~17-20MB, plus tokenizer/config files. Downloaded via `hf-hub` from HuggingFace on first use, cached under the HF cache dir (`model.rs:23-70`; honors `HF_TOKEN`).

**Languages:** 25 code + 11 text/config via the same tree-sitter family github-router already uses (`Cargo.toml` lists `tree-sitter-{typescript,python,go,rust,...}`).

---

## Index / state story — **persistent, per-workspace, index-first**

- **Builds and persists an index before search.** `colgrep init` is the documented first step (`README.md:66-80`). `commands/search.rs:1144-1228` shows that **every search** first runs a non-blocking incremental index update (`builder.try_index`), and a missing index triggers a **full build** (`search.rs:1322-1333` `builder.index(...)`). There is **no index-free / in-memory-only / per-call path** — search requires the on-disk PLAID index to exist (`search.rs:1230-1232` resolves and verifies `vector_index_path`).
- **Storage is OUTSIDE the repo** (`paths.rs:1-7,65-78`): Linux `~/.local/share/colgrep/indices/`, macOS `~/Library/Application Support/colgrep/indices/`, **Windows `%APPDATA%\colgrep\indices\`**. Per-project dir named `{project}-{xxh3(path|model)[:8]}` (`paths.rs:84-119`). So no `.cache` is written into the workspace — but this **is persistent per-workspace state** keyed by (project path, model), exactly the class of state `code_search` forbids.
- **On-disk contents** (`README.md:518-524`, `paths.rs:16-19`): `index/` (PLAID vectors + SQLite metadata), `state.json` (per-file `content_hash` + `mtime` for incremental updates — `index/state.rs:11-32`), `project.json`, and a `.lock` file (`paths.rs:233-276`, 5s lock timeout). Index size is reduced ~50% by pooling (factor 2 default) and 2/4-bit PQ, but it scales with corpus size.
- **In-repo writes:** none from indexing — but colgrep **does** write external config/integration files: global settings at `~/.config/colgrep/config.json` (`README.md:328-343`), and agent-integration plugin/hook/skill files under the data dir (`install/claude_code.rs` writes a marketplace + `hook.json` + `SKILL.md`). Read-only repo touch: it runs `git worktree list` to seed a sibling index (`index/worktree.rs:37-73`), no writes to the repo.
- **Build cost:** indexing is gated by an auto-confirm prompt for large codebases (>10K code units; `colgrep init -y` to skip — `README.md:71`), uses `rayon` parallel encoding sessions (default CPU count, max 16; `README.md:250-254`) with `indicatif` progress bars. First index of a non-trivial repo is a multi-second-to-minutes, CPU-bound, one-time cost; later searches pay only the incremental delta + query encode.

---

## Runtime / deps / Windows story

- **No Python in the binary.** colgrep is pure Rust. (The `python-sdk/` is PyO3 bindings to the tree-sitter *parser only* — `python-sdk/README.md` — not the search engine, and irrelevant to embedding it in-process.)
- **Native ONNX Runtime required.** `onnx_runtime.rs:33` pins ORT **1.23.0**; `:35-43` names the platform dylib (`libonnxruntime.dylib` / `.so` / `onnxruntime.dll`). It is **auto-downloaded from microsoft/onnxruntime GitHub releases** and cached at `~/.cache/colgrep/onnxruntime/1.23.0/{cpu|gpu}/` (`onnx_runtime.rs:535-588`, `get_download_info` `:594-718`). Lookup order: `ORT_DYLIB_PATH` env → common/Python/conda/venv paths → auto-download (`:132-160`). It is `dlopen`'d at runtime (`libloading`, `is_valid_ort_dylib` `:366-375`).
- **CPU by default, GPU opt-in.** `USE_GPU` is gated on the `cuda` cargo feature (`onnx_runtime.rs:45-48`); default build is CPU. macOS prebuilt binaries enable Accelerate+CoreML; Linux/Windows prebuilt are CPU-only with cuda/directml as opt-in cargo features (`README.md:62-64,614-624`). **No GPU is required.**
- **Windows: first-class.** Dedicated `target_os = "windows"` ORT download (`onnx_runtime.rs:675-704`, `.zip` via the `zip` dep), DirectML opt-in feature, Windows venv ONNX path probing (`:499-500`), and `%APPDATA%` index storage. The README ships a PowerShell installer.
- **Inference latency:** no in-repo microbench. README claims query encode is a "single ONNX session, fast" (`README.md:465`); CPU default batch-size 1 (`README.md:253`). Realistically tens-to-low-hundreds of ms per query on CPU for a 17M INT8 model — i.e. **much slower than ripgrep's sub-10ms lexical scan**, and that excludes the incremental re-index that runs on every search.
- **Install footprint (rough sum):** Rust binary (single-digit-to-low-tens MB) + native ORT dylib (~15-40MB) + INT8 model (~17-20MB) + per-repo index (corpus-proportional). Plus first-run network fetches from GitHub releases + HuggingFace.

---

## Usefulness vs the lexical path — skeptical read

| Query shape | Lexical (`code_search`: ripgrep + BM25F + tree-sitter) | colgrep (ColBERT + FTS5 + RRF) |
|---|---|---|
| "where is `X` defined" / "which files reference `Y`" (exact symbol) | **Strong** — exact, fast, stateless; tree-sitter already boosts definitions | No advantage; the FTS5 trigram half overlaps our lexical strength, the semantic half adds latency without recall here |
| Natural-language intent ("database connection pooling", "auth middleware") | Weak when the words don't appear literally | **Genuine edge** — semantic recall over prose/intent (`README.md:88-96`) |
| Regex-narrow then rank-by-relevance ("find async fns, rank by error handling") | Not expressible as a single op | Native (`README.md:110-123`) — a real capability we lack |

colgrep's published benchmark (`README.md:24-40`) is **Semble: 1,251 NL queries**, NDCG@10 ~0.846 (edge) / 0.859 (big) — and the bench was run **on an H100 GPU at FP32**. That is precisely the NL-intent regime where semantic search wins and where our lexical path is weakest. But `code_search`'s stated job is "where is X defined / which files reference Y" — exact-symbol discovery — where lexical is faster, exact, predictable, and stateless. The semantic edge is real but **off-axis** from `code_search`'s mission, and it is bought with an index + model + native runtime we cannot carry.

---

## Constraints matrix

| Hard constraint | colgrep | Pass? |
|---|---|---|
| Zero persistent per-workspace state / no background index | Persistent PLAID index + SQLite + `state.json` per (path, model) in app-data dir | **FAIL** |
| No `.cache` written into the user's repo | True — index is external; but global `~/.config/colgrep` + plugin files written | Pass (repo) / caveat |
| Zero heavy new runtime deps; no native/GPU in proxy process | Native ONNX Runtime dylib `dlopen`'d; GPU opt-in only | **FAIL** (native ORT) |
| No model download | Downloads ~17-20MB INT8 ColBERT from HuggingFace on first use | **FAIL** |
| No Python runtime | Pure Rust binary | **PASS** |
| Per-call, side-effect-free work only | Index-first; mutates external index on every search; no index-free path | **FAIL** |
| Windows-first | First-class Windows support | **PASS** |

---

## Verdicts

### (a) Standalone MCP tool — **NO-GO** (qualified)
colgrep exposes **no MCP server** (confirmed: zero `mcp`/`jsonrpc`/`tools/list` references in `colgrep/src`); its agent story is shelling out to the CLI via an injected SKILL + hooks (`install/SKILL.md`, `install/claude_code.rs`). To offer it ourselves we'd have to bundle/spawn an external native binary, ensure the model + ORT downloads happened, and ensure `colgrep init` had built an index — none of which a stateless proxy can guarantee, and all of which write persistent state. **Fails:** zero-state, no-model-download, no-heavy-native-dep. The only non-violating shape is a thin opt-in passthrough for users who *already* installed colgrep and indexed — but colgrep's own `--install-claude-code` does that better, outside the proxy, so we'd add nothing.

### (b) `code_search` integration — **NO-GO** (hard)
`code_search` is in-process Node/Bun, per-call, zero-state. colgrep cannot run in-process (it's a native Rust binary + dlopen'd ORT), cannot run index-free (search requires the persisted PLAID index — `search.rs:1230-1232`), and cannot avoid a model download. Embedding it would convert `code_search` from a fast stateless lexical op into a stateful service with a build phase, a model cache, and a native runtime. **Fails:** in-process, per-call, zero-state, no-model-download, no-native-dep — four binding constraints at once.

---

## Worth borrowing (conceptual only)

1. **Structured-code-unit text construction** (`README.md:424-449`): before ranking, build a normalized representation per code unit — signature, params, calls, docstring, *and* a path-normalized form (`HttpClient` → `http client`, separators → spaces, snake/Camel split). This is a **stateless, in-process** idea that could enrich our BM25F "symbol-context" / "file-path tokens" fields and improve recall on multi-word identifier queries — no model, no index required.
2. **Hybrid RRF framing** (`README.md:88-96,463-470`): if github-router ever adds an *opt-in, user-provided* external semantic index, RRF (alpha favoring semantic) is the clean fusion recipe for merging it with our lexical ranking. Not actionable today.

What is **not** worth borrowing: the ColBERT/PLAID runtime itself (model + native ONNX + persistent quantized index) — it is the exact shape `code_search`'s constraints exist to exclude.
