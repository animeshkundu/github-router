/**
 * Environment scrubbing for npm children we spawn.
 *
 * `npm_config_*` in the environment is *configuration*, not advice: npm's
 * `loadEnv` (`lib/index.js` in `@npmcli/config`) turns every non-empty
 * `npm_config_<key>` into the same setting a `.npmrc` line or a CLI flag would
 * produce, with the lowest precedence but full effect. Measured against npm
 * 11.20.0 on a fresh prefix with one pinned dependency:
 *
 * | inherited env                     | result of `npm install`        |
 * |-----------------------------------|--------------------------------|
 * | `npm_config_global=true`          | installs into `<prefix>/lib/node_modules`, `node_modules/` stays empty |
 * | `npm_config_dry_run=true`         | exit 0, **nothing installed**  |
 * | `npm_config_workspaces=true`      | `ENOWORKSPACES`, exit 0, nothing installed |
 * | `npm_config_omit=optional`        | platform packages silently missing (`@vscode/ripgrep-darwin-arm64`), so `rg` is unresolvable at run time |
 * | `npm_config_location=global`      | as `global`                    |
 * | `npm_config_prefix=/elsewhere`    | as `global` for symlinked trees |
 * | `npm_config_allow_scripts=<pkg>`  | `EALLOWSCRIPTS` (see below)     |
 *
 * Every one of those is a *successful* npm run. A managed install that trusted
 * the exit code would publish an empty or incomplete payload and then point
 * `current.json` at it — the class of failure that only shows up as "the router
 * is broken on that one machine".
 *
 * `npm_config_allow_scripts` is the sharper case and is handled separately by
 * every caller as `""` (the rule at `src/lib/server-setup.ts:1838`): a non-empty
 * env-sourced allow-scripts value makes npm throw `EALLOWSCRIPTS` for any
 * project-scoped install. Emptying it is not a policy change — npm treats `''`
 * as "not set" and falls through to the `.npmrc` cascade, which is where the
 * operator put it.
 *
 * So: keep the *connection* and *identity* settings a user legitimately needs
 * (registry, proxies, TLS, auth tokens, cache location, retry budget), drop
 * everything that changes *what gets installed where*. Anything dropped is
 * stated in the debug log so a support thread can see why an install behaved
 * differently from the user's shell.
 */

/**
 * `npm_config_*` keys we keep.
 *
 * Note what is deliberately ABSENT: `prefix`, `global`, `location`, `omit`,
 * `include`, `dry_run`, `workspaces`, `link`, `install_links`, `only`,
 * `production`, `before`, `allow_scripts`, `loglevel`. Those are the ones that
 * redirect, skip, or refuse the install.
 */
const KEEP_SIMPLE_KEYS = new Set([
  "_auth",
  "always_auth",
  "ca",
  "cafile",
  "cache",
  "cert",
  "fetch_retries",
  "fetch_retry_maxtimeout",
  "fetch_retry_mintimeout",
  "fetch_timeout",
  "globalconfig",
  "https_proxy",
  "http_proxy",
  "key",
  "local_address",
  "maxsockets",
  "no_proxy",
  "noproxy",
  "otp",
  "proxy",
  "registry",
  "strict_ssl",
  "userconfig",
])

/**
 * `//host/path/:_authToken` — a nerf-dart key. npm stores per-registry
 * credentials under this shape and `loadEnv` deliberately does not normalize it,
 * so it must be matched as a prefix rather than a name.
 */
const NERF_DART_RE = /^\/\/.*:(_authToken|_auth|username|_password|email)$/i

export interface NpmEnvScrubResult {
  env: NodeJS.ProcessEnv
  /** Keys that were removed, for the debug log. Never includes values. */
  dropped: Array<string>
  /** Keys that were kept, so a support thread can see what applied. */
  kept: Array<string>
}

/**
 * Build a child env for an npm invocation.
 *
 * `overrides` are applied last and win, so a caller can pin `npm_config_registry`
 * for Pi (`resolvePiRegistry()`) without fighting the cascade.
 *
 * The result fully REPLACES the child env (`runCommandCapture` uses
 * `opts.env ?? process.env`), so anything not copied here is genuinely absent
 * rather than merged back in from the parent.
 */
export function buildNpmEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NpmEnvScrubResult {
  const env: NodeJS.ProcessEnv = {}
  const dropped: Array<string> = []
  const kept: Array<string> = []

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    // npm itself skips empty values, so keeping them is harmless but noisy.
    if (!/^npm_config_/i.test(key)) {
      env[key] = value
      continue
    }
    if (value === "") {
      env[key] = value
      continue
    }
    const bare = key.slice("npm_config_".length).toLowerCase()
    const isKept = NERF_DART_RE.test(key.slice("npm_config_".length)) || KEEP_SIMPLE_KEYS.has(bare)
    if (isKept) {
      env[key] = value
      kept.push(key)
    } else {
      dropped.push(key)
    }
  }

  // Null an inherited allow-scripts policy for this child. See the module doc.
  env.npm_config_allow_scripts = ""

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }

  return { env, dropped, kept }
}

/**
 * Whether a managed install may run at all in this process.
 *
 * `GH_ROUTER_NO_MANAGED_INSTALL` is the user's off switch (documented in the
 * plan); `ghRouterNoManagedInstall()` is the only place that reads it so the
 * bootstrap, the CLI, and the tests cannot disagree about its spelling.
 */
export function managedInstallDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GH_ROUTER_NO_MANAGED_INSTALL?.trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
}
