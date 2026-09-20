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
 * Fallback is the `az` CLI (`az repos show --detect`), which performs the
 * same git-remote inspection server-side. Branch-index awareness
 * (`checkBranchIndexStatus`) also mirrors the extension: it probes the
 * Azure DevOps Search API so the Bluebird `x-mcp-ec-branch` header is only
 * sent when the current branch is actually indexed; otherwise the caller
 * falls back to the repo default branch.
 */

import { execFile } from "node:child_process"
import process from "node:process"

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

  // Loose matcher for URLs the URL parser rejects (embedded credentials,
  // unusual casing). Mirrors the extension's final fallback.
  const loose = url.match(
    /(?:dev\.azure\.com\/|visualstudio\.com\/)([^/]+)\/([^/]+)\/_git\/(?:_(?:optimized|full)\/)?([^/]+)/i,
  )
  if (loose) {
    const organization = nonEmpty(loose[1], MAX_ORG_LENGTH)
    const project = nonEmpty(loose[2], MAX_COMPONENT_LENGTH)
    const repository = nonEmpty(loose[3].replace(/\.git$/, ""), MAX_COMPONENT_LENGTH)
    if (organization && project && repository) {
      return { organization, project, repository }
    }
  }
  return null
}

function runCmd(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: { cwd?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      {
        cwd: opts.cwd ?? process.cwd(),
        timeout: opts.timeoutMs ?? 15_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

/** Deduplicate repo infos case-insensitively on org/project/repo. */
function dedupe(infos: ReadonlyArray<AzureRepoInfo>): Array<AzureRepoInfo> {
  const seen = new Set<string>()
  const out: Array<AzureRepoInfo> = []
  for (const info of infos) {
    const key = `${info.organization.toLowerCase()}/${info.project.toLowerCase()}/${info.repository.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(info)
  }
  return out
}

/**
 * List Azure DevOps repos from local git remotes (`git remote -v`).
 * Returns an empty array when git is unavailable, the cwd is not a repo,
 * or no remote parses as Azure DevOps. Never throws.
 */
export async function getAzureReposFromGit(cwd?: string): Promise<Array<AzureRepoInfo>> {
  try {
    const { stdout } = await runCmd("git", ["remote", "-v"], { cwd })
    const infos: Array<AzureRepoInfo> = []
    for (const line of stdout.split("\n")) {
      const parts = line.split(/\s+/)
      if (parts.length < 2) continue
      const parsed = parseAzureRepo(parts[1])
      if (parsed) infos.push(parsed)
    }
    return dedupe(infos)
  } catch {
    return []
  }
}

/**
 * Fallback detector via the `az` CLI's own git-context auto-detection
 * (`az repos show --detect`). Requires the azure-devops extension and an
 * `az login` session. Returns `null` (never throws) when unavailable.
 */
export async function getAzureRepoFromAz(cwd?: string): Promise<AzureRepoInfo | null> {
  try {
    const { stdout } = await runCmd(
      "az",
      ["repos", "show", "--detect", "true", "--query", "{organization: project.url, project: project.name, repository: name}", "--output", "json"],
      { cwd, timeoutMs: 20_000 },
    )
    const parsed = JSON.parse(stdout) as {
      organization?: string
      project?: string
      repository?: string
    }
    // `project.url` looks like
    // `https://dev.azure.com/{org}/_apis/projects/{id}` — the org is the
    // first path segment.
    const orgMatch =
      typeof parsed.organization === "string"
        ? parsed.organization.match(/dev\.azure\.com\/([^/]+)/i)
        : null
    const organization = orgMatch?.[1] ? nonEmpty(orgMatch[1], MAX_ORG_LENGTH) : null
    const project =
      typeof parsed.project === "string" ? nonEmpty(parsed.project, MAX_COMPONENT_LENGTH) : null
    const repository =
      typeof parsed.repository === "string"
        ? nonEmpty(parsed.repository, MAX_COMPONENT_LENGTH)
        : null
    if (organization && project && repository) {
      return { organization, project, repository }
    }
    return null
  } catch {
    return null
  }
}

/** Current branch of the git checkout at `cwd`, or `null`. Never throws. */
export async function getCurrentBranch(cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })
    const branch = stdout.trim()
    if (!branch || branch === "HEAD") return null
    return branch
  } catch {
    return null
  }
}

function normalizeBranch(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch
}

export interface BranchIndexStatus {
  isIndexed: boolean
  branch: string
  indexedBranches: Array<string>
}

/**
 * Check whether `branch` is indexed in Azure DevOps Search for this repo
 * (mirrors the extension's `checkBranchIndexStatus`). Used to decide
 * whether the Bluebird `x-mcp-ec-branch` header may be sent: an
 * unindexed branch would silently narrow results to nothing.
 * Returns `isIndexed: false` (never throws) on any transport/auth error.
 */
export async function checkBranchIndexStatus(
  info: AzureRepoInfo,
  branch: string,
  token: string,
): Promise<BranchIndexStatus> {
  const normalized = normalizeBranch(branch)
  const endpoint = `https://almsearch.dev.azure.com/${encodeURIComponent(info.organization)}/${encodeURIComponent(info.project)}/_apis/search/codesearchresults?api-version=7.1`
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        searchText: "a*",
        $top: 1,
        includeFacets: true,
        filters: { Project: [info.project], Repository: [info.repository] },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { isIndexed: false, branch: normalized, indexedBranches: [] }
    const body = (await res.json()) as {
      facets?: { Branch?: Array<{ name?: string }> }
    }
    const indexed = (body.facets?.Branch ?? [])
      .map((b) => (typeof b.name === "string" ? normalizeBranch(b.name) : ""))
      .filter(Boolean)
    const hit = indexed.some((b) => b.toLowerCase() === normalized.toLowerCase())
    return { isIndexed: hit, branch: normalized, indexedBranches: indexed }
  } catch {
    return { isIndexed: false, branch: normalized, indexedBranches: [] }
  }
}

/**
 * Default branch of an Azure DevOps repo via the `az` CLI.
 * Returns `null` (never throws) when unavailable.
 */
export async function getDefaultBranch(
  info: AzureRepoInfo,
  cwd?: string,
): Promise<string | null> {
  try {
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
      { cwd, timeoutMs: 20_000 },
    )
    const branch = normalizeBranch(stdout.trim().replace(/^["']|["']$/g, ""))
    return branch || null
  } catch {
    return null
  }
}
