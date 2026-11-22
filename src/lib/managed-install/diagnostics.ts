/**
 * Diagnostics sink for the managed-install layer.
 *
 * Why not `consola` directly: this layer is imported by `dist/bin.js`, which is a
 * separate bundle from `dist/main.js`. Both bundles would carry their own copy of
 * `consola`, and the bin copy's instance is a different object with different
 * configuration than the one `main.ts` configures — so a message logged through it
 * could go to a different reporter, or to none. The bin bundle also has to stay
 * cheap: it runs before anything else and must not pull a logging stack for one
 * debug line.
 *
 * So the layer takes a sink. `main.ts` installs the consola-backed one at startup
 * (`setManagedDiagnosticReporter`), and everything else is a no-op. Nothing in
 * this module is on a hot path.
 */

export type ManagedDiagnosticLevel = "debug" | "warn" | "info"

export type ManagedDiagnostic = (level: ManagedDiagnosticLevel, message: string) => void

let reporter: ManagedDiagnostic | undefined

/** Install the process-wide reporter. Called once from `main.ts`. */
export function setManagedDiagnosticReporter(next: ManagedDiagnostic | undefined): void {
  reporter = next
}

export function reportManagedDiagnostic(level: ManagedDiagnosticLevel, message: string): void {
  reporter?.(level, message)
}
