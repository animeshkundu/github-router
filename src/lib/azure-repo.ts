/**
 * Azure DevOps repository detection for the `--bluebird` flag.
 *
 * Primary source is local git-remotes parsing (instant, offline, no extra
 * dependency), ported from the Bluebird VS Code extension's `parseAzureRepo`
 * (`bluebird-ai-labs.bluebird-vscode` v1.0.0, `dist/extension.js`). The
 * extension is the reference implementation for which remote shapes exist
 * in the wild, so this file mirrors its coverage:
 *   - `https://dev.azure.com/{org}/{project}/_git/{repo}`
 *   - `git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`
 *   - `git@{org}.visualstudio.com:v3/{org}/{project}/{repo}`
 *   - legacy `*.visualstudio.com` HTTPS shapes
 *   - `_optimized` / `_full` repo-path infixes
 *
 * Git remotes are authoritative. Branch-index awareness
 * (`checkBranchIndexStatus`) also mirrors the extension: it probes the
 * Azure DevOps Search API so the Bluebird `x-mcp-ec-branch` header is only
 * sent when the current branch is actually indexed; otherwise the caller
 * falls back to the repo default branch.
 */

import { resolveExecutable, runCommandCapture } from "./exec"

export interface AzureRepoInfo {
  organization: string
  project: string
  repository: string
}

const MAX_COMPONENT_LENGTH = 64
const MAX_ORG_LENGTH = 50

function nonEmpty(value: string | undefined, max: number): string | null {
  if (!value) return null
  // The extension sanitizes header values by stripping CR/LF/NUL; reject
  // them here so a malicious remote URL can never smuggle a header split
  // into the Bluebird `x-mcp-ec-*` headers. Checked BOTH before and after
  // percent-decoding: the URL parser percent-encodes control characters
  // (`%00`), so a pre-decode check alone misses them.
  if (/[\r\n\0]/.test(value)) return null
  const decoded = safeDecode(value)
  if (!decoded || decoded.length === 0 || decoded.length > max) return null
  if (/[\r\n\0]/.test(decoded)) return null
  return decoded
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/**
 * Parse an Azure DevOps git remote URL into org/project/repo.
 * Returns `null` for non-Azure remotes (GitHub etc.) or malformed URLs.
 * Pure function — unit-testable without git/`az`.
 */
export function parseAzureRepo(remoteUrl: string | undefined | null): AzureRepoInfo | null {
  if (!remoteUrl) return null
  const url = remoteUrl.trim()
  if (!url) return null

  // SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}(.git)
  const ssh = url.match(
    /^git@ssh\.dev\.azure\.com:(?:v3\/)?([^/]+)\/([^/]+)\/(?:_(?:optimized|full)\/)?([^/]+?)(?:\.git)?$/i,
  )
  if (ssh) {
    const organization = nonEmpty(ssh[1], MAX_ORG_LENGTH)
    const project = nonEmpty(ssh[2], MAX_COMPONENT_LENGTH)
    const repository = nonEmpty(ssh[3], MAX_COMPONENT_LENGTH)
    if (organization && project && repository) {
      return { organization, project, repository }
    }
    return null
  }

  // SSH (legacy): git@{org}.visualstudio.com:v3/{org}/{project}/{repo}
  const legacySsh = url.match(
    /^git@([^.]+)\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/(?:_(?:optimized|full)\/)?([^/]+?)(?:\.git)?$/i,
  )
  if (legacySsh) {
    const organization = nonEmpty(legacySsh[2], MAX_ORG_LENGTH)
    const project = nonEmpty(legacySsh[3], MAX_COMPONENT_LENGTH)
    const repository = nonEmpty(legacySsh[4], MAX_COMPONENT_LENGTH)
    if (organization && project && repository) {
      return { organization, project, repository }
    }
    return null
  }

  // HTTPS shapes are easiest via URL parsing.
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const segments = parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean)
    if (host === "dev.azure.com") {
      const gitIdx = segments.findIndex((s) => s.toLowerCase() === "_git")
      if (gitIdx >= 2) {
        const after = segments.slice(gitIdx + 1)
        const repo =
          after[0]?.toLowerCase() === "_optimized" || after[0]?.toLowerCase() === "_full"
            ? after[1]
            : after[0]
        const organization = nonEmpty(segments[0], MAX_ORG_LENGTH)
        const project = nonEmpty(segments[1], MAX_COMPONENT_LENGTH)
        const repository = nonEmpty(repo, MAX_COMPONENT_LENGTH)
        if (organization && project && repository) {
          return { organization, project, repository }
        }
      }
    }
    if (host.endsWith(".visualstudio.com")) {
      const organization = nonEmpty(host.replace(/\.visualstudio\.com$/, ""), MAX_ORG_LENGTH)
      const gitIdx = segments.findIndex((s) => s.toLowerCase() === "_git")
      if (gitIdx >= 1 && organization) {
        const project = nonEmpty(segments[gitIdx - 1], MAX_COMPONENT_LENGTH)
        const after = segments.slice(gitIdx + 1)
        const repo =
          after[0]?.toLowerCase() === "_optimized" || after[0]?.toLowerCase() === "_full"
            ? after[1]
            : after[0]
        const repository = nonEmpty(repo, MAX_COMPONENT_LENGTH)
        if (project && repository) {
          return { organization, project, repository }
        }
      }
    }
  } catch {
    // Not a parseable absolute URL — fall through to the loose matcher.
  }

  return null
}

async function runCmd(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  const executable = resolveExecutable(cmd, { cwd: opts.cwd })
  if (!executable) throw new Error(`${cmd} executable was not found on PATH`)
  if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted")
  const result = await runCommandCapture([executable, ...args], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 15_000,
    maxStdoutBytes: 1024 * 1024,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted")
  if (result.timedOut) throw new Error(`${cmd} timed out`)
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`${cmd} exited with code ${result.code ?? "unknown"}${detail ? `: ${detail.slice(0, 500)}` : ""}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

export interface AzureRemoteEntry {
  name: string
  url: string
  type: "fetch" | "push"
  info: AzureRepoInfo | null
}

export interface ParsedGitRemote {
  name: string
  url: string
  type: "fetch" | "push"
}

/** Parse one `git remote -v` line without losing its name or direction. */
export function parseGitRemoteLine(line: string): ParsedGitRemote | null {
  const match = line.trim().match(/^(\S+)\s+(.*?)\s+\((fetch|push)\)$/i)
  if (!match) return null
  return {
    name: match[1],
    url: match[2].trim(),
    type: match[3].toLowerCase() as "fetch" | "push",
  }
}

export function parseGitRemoteOutput(stdout: string): Array<AzureRemoteEntry> {
  const entries: Array<AzureRemoteEntry> = []
  for (const line of stdout.split("\n")) {
    const parsed = parseGitRemoteLine(line)
    if (!parsed) continue
    entries.push({
      ...parsed,
      info: parseAzureRepo(parsed.url),
    })
  }
  return entries
}

export function sameAzureRepo(a: AzureRepoInfo, b: AzureRepoInfo): boolean {
  return (
    a.organization.toLowerCase() === b.organization.toLowerCase()
    && a.project.toLowerCase() === b.project.toLowerCase()
    && a.repository.toLowerCase() === b.repository.toLowerCase()
  )
}

interface DistinctAzureRepo {
  info: AzureRepoInfo
  remoteNames: Set<string>
}

function distinctAzureRepos(
  entries: ReadonlyArray<AzureRemoteEntry>,
): Array<DistinctAzureRepo> {
  const distinct: Array<DistinctAzureRepo> = []
  for (const entry of entries) {
    const entryInfo = entry.info
    if (!entryInfo) continue
    const existing = distinct.find(({ info }) => sameAzureRepo(info, entryInfo))
    if (existing) existing.remoteNames.add(entry.name)
    else {
      distinct.push({
        info: entryInfo,
        remoteNames: new Set([entry.name]),
      })
    }
  }
  return distinct
}

/**
 * Resolve exactly one checked-out Azure DevOps repository from git remotes.
 * An Azure `origin` fetch target is authoritative. Matching fetch/push and
 * duplicate lines collapse; only distinct Azure targets can conflict.
 */
export function resolveAzureRepoFromRemotes(
  entries: ReadonlyArray<AzureRemoteEntry>,
): AzureRepoInfo {
  const originEntries = entries.filter(
    (entry) => entry.name.toLowerCase() === "origin",
  )
  const originFetches = distinctAzureRepos(
    originEntries.filter((entry) => entry.type === "fetch"),
  )

  if (originFetches.length > 1) {
    throw new Error(
      "Conflicting Azure DevOps repositories configured for origin remote.",
    )
  }
  if (originFetches.length === 1) {
    const selected = originFetches[0].info
    const conflictingAzureOrigin = originEntries.some(
      (entry) => entry.info && !sameAzureRepo(entry.info, selected),
    )
    if (conflictingAzureOrigin) {
      throw new Error(
        "Conflicting Azure DevOps repositories configured for origin remote.",
      )
    }
    return selected
  }

  const distinct = distinctAzureRepos(entries)
  if (distinct.length === 0) {
    throw new Error(
      "No supported Azure DevOps repository remote was found for this workspace. "
      + "Git remotes are authoritative for Bluebird scope discovery; add a "
      + "dev.azure.com or visualstudio.com remote. Exact/regex/ast modes still "
      + "use the local engine.",
    )
  }
  if (distinct.length === 1) return distinct[0].info

  const remoteNames = [
    ...new Set(
      distinct.flatMap(({ remoteNames: names }) => [...names]),
    ),
  ].sort()
  throw new Error(
    `Ambiguous Azure DevOps repositories found across remotes: ${remoteNames.join(", ")}.`,
  )
}

/** Authoritative Azure DevOps repository from `git remote -v`. */
export async function getAzureRepoFromGit(
  cwd?: string,
  signal?: AbortSignal,
): Promise<AzureRepoInfo> {
  const { stdout } = await runCmd("git", ["remote", "-v"], { cwd, signal })
  return resolveAzureRepoFromRemotes(parseGitRemoteOutput(stdout))
}

/**
 * Current branch of the git checkout, or `null` only for detached HEAD.
 * Git failures and cancellation remain visible.
 */
export async function getCurrentBranch(
  cwd?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const { stdout } = await runCmd(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd, signal },
  )
  const branch = stdout.trim()
  if (!branch || branch === "HEAD") return null
  return branch
}

function normalizeBranch(branch: string): string {
  return branch.startsWith("refs/heads/")
    ? branch.slice("refs/heads/".length)
    : branch
}

export interface BranchIndexStatus {
  isIndexed: boolean
  branch: string
  indexedBranches: Array<string>
}

/**
 * Probe Azure DevOps Search for indexed branches. Transport, authentication,
 * HTTP, cancellation, timeout, and response-shape failures remain visible.
 */
export async function checkBranchIndexStatus(
  info: AzureRepoInfo,
  branch: string,
  token: string,
  signal?: AbortSignal,
): Promise<BranchIndexStatus> {
  const normalized = normalizeBranch(branch)
  const endpoint = `https://almsearch.dev.azure.com/${encodeURIComponent(info.organization)}/${encodeURIComponent(info.project)}/_apis/search/codesearchresults?api-version=7.1`
  const timeoutSignal = AbortSignal.timeout(15_000)
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        searchText: "a*",
        $top: 1,
        includeFacets: true,
        filters: {
          Project: [info.project],
          Repository: [info.repository],
        },
      }),
      signal: requestSignal,
    })
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Branch index status check cancelled.")
    }
    if (timeoutSignal.aborted) {
      throw new Error(
        "Branch index status check timed out after 15000ms.",
        { cause: error },
      )
    }
    throw new Error("Branch index status check transport failed.", {
      cause: error,
    })
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Branch index status check authentication failed with HTTP ${response.status}.`,
    )
  }
  if (!response.ok) {
    throw new Error(
      `Branch index status check failed with HTTP ${response.status}.`,
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Branch index status check cancelled.")
    }
    if (timeoutSignal.aborted) {
      throw new Error(
        "Branch index status check timed out after 15000ms.",
        { cause: error },
      )
    }
    throw new Error(
      "Branch index status check returned malformed JSON.",
      { cause: error },
    )
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(
      "Branch index status check returned an invalid response shape.",
    )
  }
  const facets = (body as Record<string, unknown>).facets
  if (!facets || typeof facets !== "object" || Array.isArray(facets)) {
    throw new Error(
      "Branch index status check returned an invalid response shape.",
    )
  }
  const branchFacet = (facets as Record<string, unknown>).Branch
  if (!Array.isArray(branchFacet)) {
    throw new Error(
      "Branch index status check returned an invalid response shape.",
    )
  }

  const indexed: Array<string> = []
  for (const row of branchFacet) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(
        "Branch index status check returned an invalid response shape.",
      )
    }
    const name = (row as Record<string, unknown>).name
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(
        "Branch index status check returned an invalid response shape.",
      )
    }
    indexed.push(normalizeBranch(name))
  }

  return {
    isIndexed: indexed.some(
      (candidate) => candidate.toLowerCase() === normalized.toLowerCase(),
    ),
    branch: normalized,
    indexedBranches: indexed,
  }
}

/** Default branch of an Azure DevOps repo via the `az` CLI. */
export async function getDefaultBranch(
  info: AzureRepoInfo,
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await runCmd(
    "az",
    [
      "repos",
      "show",
      "--repository",
      info.repository,
      "--organization",
      `https://dev.azure.com/${info.organization}`,
      "--project",
      info.project,
      "--query",
      "defaultBranch",
      "--output",
      "tsv",
    ],
    { cwd, timeoutMs: 20_000, signal },
  )
  const branch = normalizeBranch(
    stdout.trim().replace(/^["']|["']$/g, ""),
  )
  if (!branch) {
    throw new Error("Azure CLI returned an empty default branch.")
  }
  return branch
}
