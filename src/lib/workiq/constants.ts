/**
 * Constants for the Work IQ (Microsoft 365) MCP group.
 *
 * Work IQ is a hosted Streamable HTTP MCP server at
 * `https://workiq.svc.cloud.microsoft/mcp`. It is protected by Entra ID, and
 * its protected-resource metadata advertises a single scope,
 * `api://workiq.svc.cloud.microsoft/.default`, whose audience is
 * `fdcc1f02-fc51-4226-8753-f668596af7f7`. That metadata publishes no
 * authorization-server information, so dynamic client registration is not
 * available and the public client id has to be known in advance. The value
 * below is the same public client the official Work IQ Claude plugin ships and
 * the CLI prints; it is a PUBLIC native client, so it carries no secret and
 * its presence here is not a credential.
 *
 * Auth is therefore a loopback authorization-code flow with PKCE, driven
 * entirely from this process. Nothing here shells out to the `workiq` CLI: the
 * CLI bundles its own MSAL cache (`~/.work-iq-cli/msal_token_cache.dat`, DPAPI
 * encrypted and opaque outside .NET), and the MCP endpoint is reachable
 * without it.
 */

/** Hosted MCP endpoint. Streamable HTTP, stateless: no `Mcp-Session-Id`. */
export const WORKIQ_MCP_HOST = "https://workiq.svc.cloud.microsoft"
export const WORKIQ_MCP_URL = `${WORKIQ_MCP_HOST}/mcp`

/** Entra application (resource) id the access token is minted for. */
export const WORKIQ_RESOURCE_APP_ID = "fdcc1f02-fc51-4226-8753-f668596af7f7"

/** Resource URI form, as accepted by the `.default` scope. */
export const WORKIQ_RESOURCE = "api://workiq.svc.cloud.microsoft"

/**
 * Scopes requested in one string. `.default` is what yields the delegated
 * `WorkIQ.Act WorkIQ.Read WorkIQAgent.Ask` set on the access token; `openid
 * profile` give us the `id_token` we read the account name from; and
 * `offline_access` is what makes Entra issue the refresh token the durable
 * login depends on.
 */
export const WORKIQ_SCOPE = `${WORKIQ_RESOURCE}/.default openid profile offline_access`

/** Public native client id (no secret). See the module comment. */
export const WORKIQ_PUBLIC_CLIENT_ID = "ba081686-5d24-4bc6-a0d6-d034ecffed87"

/**
 * MCP protocol version. The live server answers `2025-06-18`, the same
 * version the Azure groups use.
 */
export const WORKIQ_PROTOCOL_VERSION = "2025-06-18"

/**
 * Multi-tenant authority segment. `organizations` accepts any work or school
 * account, which is what the CLI's MSAL config uses (its tenant is empty).
 * Override with `GH_ROUTER_WORKIQ_TENANT` for a single-tenant deployment.
 */
export const WORKIQ_DEFAULT_TENANT = "organizations"

export const WORKIQ_TENANT_ENV = "GH_ROUTER_WORKIQ_TENANT"

/**
 * Raw bearer override for tests and manual runs. It skips both the token file
 * and the refresh path entirely.
 */
export const WORKIQ_TOKEN_ENV = "WORKIQ_MCP_TOKEN"

/** Overrides the durable token file path (tests, shared installs). */
export const WORKIQ_TOKEN_PATH_ENV = "GH_ROUTER_WORKIQ_TOKEN_PATH"

/**
 * The eight tools that only read M365 data, keyed by the exact names the live
 * server advertises (`tools/list` on 2026-11-02 listed exactly twelve).
 *
 * `call_function` is here because the server's own description defines it as a
 * read-only Work IQ function call (Graph functions use GET). The four mutating
 * tools are in `WORKIQ_WRITE_TOOLS`.
 */
export const WORKIQ_READ_TOOLS: ReadonlySet<string> = new Set([
  "ask",
  "retrieve",
  "fetch",
  "fetch_blob",
  "list_agents",
  "get_schema",
  "search_paths",
  "call_function",
])

/** The four tools that change M365 state. Exposed only with `--workiq-write`. */
export const WORKIQ_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "create_entity",
  "update_entity",
  "delete_entity",
  "do_action",
])

/**
 * Structured-content key carrying the authoritative `retrieve` payload. The
 * same shape is documented for the hosted service; `markdown` is the rendered
 * answer and `retrievalHits` the citation set.
 */
export const WORKIQ_RETRIEVAL_CONTENT_TYPE = "application/vnd.ms-workiq.retrieval"
