import { ghRest } from "~/lib/agent/rest"
import type { RepoRef } from "~/lib/agent/types"

export type ScaffoldHelperErrorCode = "invalid-repo" | "invalid-ref" | "api-error"

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

export async function getDefaultBranch(repo: RepoRef, signal?: AbortSignal): Promise<string> {
  try {
    const response = await ghRest<RepositoryResponse>("GET", repoPath(repo), { signal })
    const branch = response.default_branch?.trim()
    if (!branch) {
      throw new ScaffoldHelperError(
        "api-error",
        `Repository ${repoLabel(repo)} did not report a default branch`,
      )
    }
    return normalizeBranchRef(branch)
  } catch (err) {
    if (err instanceof ScaffoldHelperError) throw err
    throw new ScaffoldHelperError(
      "api-error",
      `Failed to read repository ${repoLabel(repo)}`,
      { cause: err },
    )
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
): Promise<string> {
  const normalizedBase = normalizeBranchRef(baseBranch)
  try {
    const response = await ghRest<PullRequestResponse>("POST", `${repoPath(repo)}/pulls`, {
      signal,
      body: {
        title: "Seed agentic-dev repository conventions",
        head: branch,
        base: normalizedBase,
        body: "Seeds deterministic repository convention files and living documentation templates.",
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

function gitRefBranchPath(branch: string): string {
  return branch.split("/").map(segment).join("/")
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value))
}
