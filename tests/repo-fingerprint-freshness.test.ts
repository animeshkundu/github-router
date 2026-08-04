import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  repoFingerprint,
  repoRoot,
} from "~/lib/orchestration/stop-gate-policy"

/**
 * `repoFingerprint` is the freshness half of a security control:
 * `isRepoTrusted` compares the fingerprint stored at trust time against the
 * LIVE one, so that a DIFFERENT repository appearing at a previously-trusted
 * path is not silently trusted.
 *
 * It spawns git on every call, which is tempting to memoize for speed — a
 * `github-router claude` launch makes several of these. This test exists
 * because that optimization was attempted, and it silently defeated the
 * control: with a per-process memo, the swap below keeps returning the OLD
 * root commit, the comparison in `isRepoTrusted` matches, and the swapped-in
 * repo is auto-trusted for the rest of the session. The proxy is long-lived,
 * so "the rest of the session" can be hours.
 *
 * If a future change memoizes this function, this test fails.
 */
test("repoFingerprint reflects a repo swap at the same path", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ghr-fp-swap-"))
  const git = (args: Array<string>) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" })

  git(["init", "-q"])
  git(["config", "user.email", "t@example.invalid"])
  git(["config", "user.name", "t"])
  await fsp.writeFile(path.join(dir, "a"), "A")
  git(["add", "-A"])
  git(["commit", "-qm", "A"])

  const before = await repoFingerprint(dir)
  expect(before).toMatch(/^[0-9a-f]{40}$/)

  // Same path, entirely different repository.
  await fsp.rm(path.join(dir, ".git"), { recursive: true, force: true })
  git(["init", "-q"])
  git(["config", "user.email", "t@example.invalid"])
  git(["config", "user.name", "t"])
  await fsp.writeFile(path.join(dir, "b"), "B")
  git(["add", "-A"])
  git(["commit", "-qm", "B"])

  const after = await repoFingerprint(dir)
  const live = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: dir,
    stdio: "pipe",
  })
    .toString()
    .trim()

  // The identity must track the repo actually on disk, not a cached answer.
  expect(after).toBe(live)
  expect(after).not.toBe(before)

  await fsp.rm(dir, { recursive: true, force: true })
}, 60_000)

/**
 * `repoRoot` IS memoized (it re-spawned git three times per launch), but only
 * on success. A failed probe resolves with the `cwd` fallback rather than
 * rejecting, and pinning that would be worse than the spawn it saves: the
 * fallback feeds `trustFileFor`, so a pinned `cwd` keys trust on a
 * subdirectory instead of the repo root, for the life of the process. Git
 * timeouts are routine on the Windows target (cold disk, AV scanning git.exe,
 * OneDrive-synced repos).
 */
test("repoRoot does not pin a failed lookup's fallback", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ghr-root-fb-"))

  // Not a repo yet: the probe fails and falls back to cwd.
  expect(await repoRoot(dir)).toBe(dir)

  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" })

  // The next call must re-probe and find the real root, not serve the pinned
  // fallback.
  const after = await repoRoot(dir)
  const live = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    stdio: "pipe",
  })
    .toString()
    .trim()
  expect(after).toBe(live)

  await fsp.rm(dir, { recursive: true, force: true })
}, 60_000)
