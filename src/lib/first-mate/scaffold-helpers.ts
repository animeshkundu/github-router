import { ghRest } from "~/lib/agent/rest"
import type { RepoRef } from "~/lib/agent/types"

export type ScaffoldHelperErrorCode
  = "invalid-repo" | "invalid-ref" | "api-error" | "repo-not-allowed"

export class ScaffoldHelperError extends Error {
  readonly code: ScaffoldHelperErrorCode
  readonly cause?: unknown

  constructor(code: ScaffoldHelperErrorCode, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = "ScaffoldHelperError"
    this.code = code
    this.cause = options?.cause
  }
}

interface RepositoryResponse {
  default_branch?: string | null
  description?: string | null
}

interface RepositoryDetails {
  defaultBranch: string
  description?: string
}

interface ContentResponse {
  type?: string | null
  content?: string | null
  encoding?: string | null
  name?: string | null
}

interface GitRefResponse {
  object?: {
    sha?: string | null
  } | null
}

interface PullRequestResponse {
  html_url?: string | null
  url?: string | null
}

export function parseRepoSlug(value: string): RepoRef {
  const trimmed = value.trim()
  const parts = trimmed.split("/")
  if (
    parts.length !== 2
    || parts[0] === undefined
    || parts[1] === undefined
    || parts[0].trim() === ""
    || parts[1].trim() === ""
  ) {
    throw new ScaffoldHelperError(
      "invalid-repo",
      `repo must be an owner/name string; got ${JSON.stringify(value)}`,
    )
  }
  return { owner: parts[0].trim(), repo: parts[1].trim() }
}

/**
 * Repositories `scaffold_repo` is permitted to write to.
 *
 * `parseRepoSlug` validates SHAPE only, so before this gate any `owner/name`
 * the agent token could reach was writable. The tool's own description says it
 * "is not for arbitrary third-party repositories" — that was prose in a model-
 * facing string, not enforcement.
 *
 * Why it matters here specifically: `--browse` ingests arbitrary web content,
 * and that content reaches a model whose tool surface (under `--agents`, with
 * the second write-scoped token) includes creating branches, committing files,
 * and opening PRs. A fetched page that talks a model into naming a different
 * repo is the realistic version of that risk, and nothing downstream would
 * have caught it: the branch+PR flow and the human merge gate bound the BLAST
 * RADIUS of a write, but neither constrains WHICH repo it lands in.
 *
 * Configured with `GH_ROUTER_FM_SCAFFOLD_REPOS` as a comma-separated list of
 * `owner/name` entries; `owner/*` allows a whole org. Matching is
 * case-insensitive (GitHub logins are). Unset means DENY-ALL rather than
 * allow-all: a default-open gate is not a gate, and the operator who wants
 * scaffolding is the one who knows which repos they own. The error names the
 * env var so the honest use case is one copy-paste away.
 */
export function assertScaffoldRepoAllowed(repo: RepoRef): void {
  const raw = process.env.GH_ROUTER_FM_SCAFFOLD_REPOS ?? ""
  const patterns = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)

  const slug = `${repo.owner}/${repo.repo}`.toLowerCase()
  const allowed = patterns.some(
    (pattern) =>
      pattern === slug || pattern === `${repo.owner.toLowerCase()}/*`,
  )
  if (allowed) return

  throw new ScaffoldHelperError(
    "repo-not-allowed",
    `scaffold_repo refused ${slug}: it is not in the allowlist. This tool creates `
    + `branches, commits files, and opens pull requests, so it is restricted to `
    + `repositories the operator has named. Set GH_ROUTER_FM_SCAFFOLD_REPOS to a `
    + `comma-separated list of owner/name entries (or owner/* for a whole org) to `
    + `permit it.`
      + (patterns.length === 0
        ? " It is currently unset, so every repository is denied."
        : ""),
  )
  // NOTE: the error deliberately does NOT list the configured entries. This
  // message is a tool result that goes back to the model, and under `--browse`
  // that model may be acting on untrusted web content. Echoing the allowlist
  // would turn a denied call into an oracle for the operator's private
  // repository names. The denied slug plus the env var is everything a
  // legitimate operator needs; the current value is theirs to read.
}

export function normalizeBranchRef(value: string): string {
  const trimmed = value.trim()
  const withoutRefsPrefix = trimmed.startsWith("refs/heads/")
    ? trimmed.slice("refs/heads/".length)
    : trimmed.startsWith("heads/")
      ? trimmed.slice("heads/".length)
      : trimmed
  if (withoutRefsPrefix === "" || withoutRefsPrefix.includes("\\")) {
    throw new ScaffoldHelperError(
      "invalid-ref",
      `branch ref must be a non-empty branch name; got ${JSON.stringify(value)}`,
    )
  }
  return withoutRefsPrefix
}

export async function getRepositoryDetails(repo: RepoRef, signal?: AbortSignal): Promise<RepositoryDetails> {
  try {
    const response = await ghRest<RepositoryResponse>("GET", repoPath(repo), { signal })
    const branch = response.default_branch?.trim()
    if (!branch) {
      throw new ScaffoldHelperError(
        "api-error",
        `Repository ${repoLabel(repo)} did not report a default branch`,
      )
    }
    const description = response.description?.trim()
    return {
      defaultBranch: normalizeBranchRef(branch),
      ...(description ? { description } : {}),
    }
  } catch (err) {
    if (err instanceof ScaffoldHelperError) throw err
    throw new ScaffoldHelperError(
      "api-error",
      `Failed to read repository ${repoLabel(repo)}`,
      { cause: err },
    )
  }
}

export async function getDefaultBranch(repo: RepoRef, signal?: AbortSignal): Promise<string> {
  return (await getRepositoryDetails(repo, signal)).defaultBranch
}

export async function readRepoTextFile(
  repo: RepoRef,
  path: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await ghRest<ContentResponse>(
      "GET",
      `${repoPath(repo)}/contents/${repoContentPath(path)}?ref=${segment(ref)}`,
      { signal },
    )
    const content = response.content
    if (response.type !== "file" || typeof content !== "string") return undefined
    if (response.encoding !== "base64") return undefined
    return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8")
  } catch (err) {
    if (isNotFoundError(err)) return undefined
    throw new ScaffoldHelperError("api-error", `Failed to read ${path} in ${repoLabel(repo)}`, { cause: err })
  }
}

export async function readRepoDirectoryNames(
  repo: RepoRef,
  path: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const response = await ghRest<ContentResponse[]>(
      "GET",
      `${repoPath(repo)}/contents/${repoContentPath(path)}?ref=${segment(ref)}`,
      { signal },
    )
    if (!Array.isArray(response)) return []
    return response.flatMap((entry) => {
      const name = entry.name
      return typeof name === "string" && name.trim() !== "" ? [name.trim()] : []
    })
  } catch (err) {
    if (isNotFoundError(err)) return []
    throw new ScaffoldHelperError("api-error", `Failed to list ${path} in ${repoLabel(repo)}`, { cause: err })
  }
}

export function scaffoldBranchName(timestampMs = Date.now()): string {
  return `scaffold/agentic-dev-${timestampMs}`
}

export async function createScaffoldBranch(
  repo: RepoRef,
  baseBranch: string,
  signal?: AbortSignal,
): Promise<string> {
  const normalizedBase = normalizeBranchRef(baseBranch)
  const branch = scaffoldBranchName()
  try {
    const baseRef = await ghRest<GitRefResponse>(
      "GET",
      `${repoPath(repo)}/git/ref/heads/${gitRefBranchPath(normalizedBase)}`,
      { signal },
    )
    const baseSha = baseRef.object?.sha
    if (!baseSha) {
      throw new ScaffoldHelperError(
        "api-error",
        `Base branch ${normalizedBase} in ${repoLabel(repo)} did not report a commit sha`,
      )
    }
    await ghRest<unknown>("POST", `${repoPath(repo)}/git/refs`, {
      signal,
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    })
    return branch
  } catch (err) {
    if (err instanceof ScaffoldHelperError) throw err
    throw new ScaffoldHelperError(
      "api-error",
      `Failed to create scaffold branch for ${repoLabel(repo)}`,
      { cause: err },
    )
  }
}

export async function createScaffoldPullRequest(
  repo: RepoRef,
  branch: string,
  baseBranch: string,
  signal?: AbortSignal,
  body = "Seeds deterministic repository convention files and living documentation templates.",
): Promise<string> {
  const normalizedBase = normalizeBranchRef(baseBranch)
  try {
    const response = await ghRest<PullRequestResponse>("POST", `${repoPath(repo)}/pulls`, {
      signal,
      body: {
        title: "Seed agentic-dev repository conventions",
        head: branch,
        base: normalizedBase,
        body,
      },
    })
    return response.html_url ?? response.url ?? ""
  } catch (err) {
    throw new ScaffoldHelperError(
      "api-error",
      `Failed to create scaffold pull request for ${repoLabel(repo)}`,
      { cause: err },
    )
  }
}

/**
 * Delete a scaffold branch. Used to avoid leaving an orphan branch behind when
 * a no-op scaffold (everything already present) committed nothing and therefore
 * skips PR creation. Best-effort: a delete failure is surfaced as an
 * `api-error` so the caller can decide, but the no-op path itself already
 * returned no PR.
 */
export async function deleteScaffoldBranch(
  repo: RepoRef,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  const normalizedBranch = normalizeBranchRef(branch)
  try {
    await ghRest<unknown>(
      "DELETE",
      `${repoPath(repo)}/git/refs/heads/${gitRefBranchPath(normalizedBranch)}`,
      { signal },
    )
  } catch (err) {
    if (err instanceof ScaffoldHelperError) throw err
    throw new ScaffoldHelperError(
      "api-error",
      `Failed to delete scaffold branch ${normalizedBranch} for ${repoLabel(repo)}`,
      { cause: err },
    )
  }
}

function repoLabel(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`
}

function repoPath(repo: RepoRef): string {
  return `/repos/${segment(repo.owner)}/${segment(repo.repo)}`
}

function repoContentPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === "" || trimmed === ".") return ""
  return trimmed.split("/").map(segment).join("/")
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === "object"
    && err !== null
    && "code" in err
    && (err as { code?: unknown }).code === "NOT_FOUND"
}

function gitRefBranchPath(branch: string): string {
  return branch.split("/").map(segment).join("/")
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value))
}
