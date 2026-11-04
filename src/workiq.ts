#!/usr/bin/env node

/**
 * `github-router workiq` — manage the durable Work IQ sign-in.
 *
 * The proxy itself never prompts: `--workiq` provisioning calls
 * `ensureWorkiqToken()`, and a missing or dead login downgrades the group with
 * a pointer at `workiq auth` rather than stalling a launch. So this command is
 * the one interactive surface, and it is deliberately separate from any
 * command that starts a server.
 *
 * Nothing here prints a token. `auth` reports the account and the expiry,
 * `status` reports the same plus the file path, and both report the access
 * token only as the SHA-256 fingerprint prefix the refresh path already logs.
 */

import { defineCommand, showUsage } from "citty"
import consola from "consola"

import {
  AUTH_REMEDY,
  WorkiqAuthError,
  deleteWorkiqTokenFile,
  readWorkiqTokenFile,
  runLoopbackAuth,
  workiqTenant,
  workiqTokenPath,
} from "./lib/workiq/token"
import { WORKIQ_TOKEN_ENV } from "./lib/workiq/constants"

interface RunWorkiqAuthOptions {
  tenant?: string
  loginHint?: string
}

export async function runWorkiqAuth(options: RunWorkiqAuthOptions = {}): Promise<void> {
  try {
    const file = await runLoopbackAuth({
      ...(options.tenant ? { tenant: options.tenant } : {}),
      ...(options.loginHint ? { loginHint: options.loginHint } : {}),
    })
    consola.info(`Token file: ${workiqTokenPath()}`)
    consola.info(`Expires: ${new Date(file.expiresAtMs).toISOString()} (refreshes automatically)`)
  } catch (err) {
    if (err instanceof WorkiqAuthError) {
      consola.error(err.message)
      if (err.errorCode === "invalid_grant" || err.errorCode === "interaction_required") {
        consola.info("The refresh token is no longer valid. Sign in again to replace it.")
      }
      process.exitCode = 1
      return
    }
    throw err
  }
}

interface WorkiqStatus {
  signedIn: boolean
  tokenPath: string
  account?: string
  expiresAt?: string
  expired?: boolean
  scope?: string
  tenant?: string
  clientId?: string
  /** Set when `WORKIQ_MCP_TOKEN` short-circuits the file entirely. */
  envBearer?: boolean
}

async function collectStatus(): Promise<WorkiqStatus> {
  const tokenPath = workiqTokenPath()
  const envBearer = Boolean(process.env[WORKIQ_TOKEN_ENV]?.trim())
  const file = await readWorkiqTokenFile(tokenPath)
  if (!file) return { signedIn: false, tokenPath, ...(envBearer ? { envBearer } : {}) }
  return {
    signedIn: true,
    tokenPath,
    ...(file.account ? { account: file.account } : {}),
    expiresAt: new Date(file.expiresAtMs).toISOString(),
    expired: file.expiresAtMs <= Date.now(),
    scope: file.scope,
    tenant: file.tenant,
    clientId: file.clientId,
    ...(envBearer ? { envBearer } : {}),
  }
}

export async function runWorkiqStatus(options: { json: boolean }): Promise<void> {
  const status = await collectStatus()
  if (options.json) {
    console.log(JSON.stringify(status, null, 2))
    if (!status.signedIn) process.exitCode = 1
    return
  }
  if (!status.signedIn) {
    consola.warn("Not signed in to Work IQ.")
    consola.info(AUTH_REMEDY)
    if (status.envBearer) consola.info("(WORKIQ_MCP_TOKEN is set, so the proxy uses that bearer.)")
    process.exitCode = 1
    return
  }
  consola.info(`Account: ${status.account ?? "(unknown)"}`)
  consola.info(`Expires: ${status.expiresAt}${status.expired ? " (expired; refreshes on next use)" : ""}`)
  consola.info(`Tenant: ${status.tenant}`)
  consola.info(`Scope: ${status.scope}`)
  consola.info(`Token file: ${status.tokenPath}`)
  if (status.envBearer) {
    consola.info(`Note: ${WORKIQ_TOKEN_ENV} is set, so the proxy uses that bearer instead of this file.`)
  }
}

export async function runWorkiqLogout(): Promise<void> {
  const removed = await deleteWorkiqTokenFile()
  if (removed) consola.success(`Work IQ sign-in removed (${workiqTokenPath()}).`)
  else consola.info("No Work IQ sign-in to remove.")
}

const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Sign in to Work IQ through the browser and store the refresh token",
  },
  args: {
    tenant: {
      type: "string",
      description: `Entra tenant segment (default: ${workiqTenant()})`,
    },
    "login-hint": {
      type: "string",
      description: "Account name to pre-select in the sign-in page",
    },
  },
  run({ args }) {
    return runWorkiqAuth({
      ...(args.tenant ? { tenant: args.tenant } : {}),
      ...(args["login-hint"] ? { loginHint: args["login-hint"] } : {}),
    })
  },
})

const status = defineCommand({
  meta: {
    name: "status",
    description: "Print the stored Work IQ sign-in without revealing the token",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "Output status as JSON",
    },
  },
  run({ args }) {
    return runWorkiqStatus({ json: args.json })
  },
})

const logout = defineCommand({
  meta: {
    name: "logout",
    description: "Delete the stored Work IQ sign-in",
  },
  run() {
    return runWorkiqLogout()
  },
})

export const workiq = defineCommand({
  meta: {
    name: "workiq",
    description: "Manage the Work IQ (Microsoft 365) sign-in used by the workiq MCP group",
  },
  subCommands: { auth, status, logout },
  run({ rawArgs }) {
    // A bare `github-router workiq` prints usage rather than silently doing
    // nothing; the default citty path would exit 0 with no output.
    if (rawArgs.length === 0) return showUsage(workiq)
    return undefined
  },
})
