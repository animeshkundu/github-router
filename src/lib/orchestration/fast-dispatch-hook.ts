import { buildSelfCommand, type SelfInvocation } from "../hook-launcher/self-invocation"
import { FAST_DISPATCH_TOOL_MATCHER } from "../fast-dispatch-acl"

/** The anchored matcher Claude Code applies before invoking the guard. */
export { FAST_DISPATCH_TOOL_MATCHER as FAST_DISPATCH_GUARD_MATCHER } from "../fast-dispatch-acl"

/** Sentinel preserved through claude.ts's optional codex-MCP catch. */
export class FastDispatchGuardInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FastDispatchGuardInstallError"
  }
}

/** Assert fast launches never spawn without their native dispatch ACL. */
export function assertFastDispatchGuardInstalled(
  fastProfile: boolean,
  installationSucceeded: boolean,
): void {
  if (fastProfile && !installationSucceeded) {
    throw new FastDispatchGuardInstallError(
      "fast profile requires the native Task/Agent ACL hook, but it could not be installed; refusing to start an unguarded fast session.",
    )
  }
}

/** Build the persisted command for the fast-profile native dispatch guard. */
export function buildFastDispatchGuardHookCommand(invocation: SelfInvocation): string {
  return buildSelfCommand(invocation, "internal-fast-dispatch-guard")
}

/** Install the fast-only hook through the shared settings writer. */
export async function installFastDispatchGuard(
  settingsPath: string,
  command: string,
  inject: (
    settingsPath: string,
    command: string,
    event: string,
    timeoutSec: number,
    matcher: string,
  ) => Promise<unknown>,
): Promise<void> {
  await inject(settingsPath, command, "PreToolUse", 10, FAST_DISPATCH_TOOL_MATCHER)
}

/** This module is intentionally stateless; callers own launch cleanup. */
