// VENDOR STUB (github-router): the upstream `utils/diagnostics.ts` exports a
// `AssistantMessageDiagnostic` type plus a small bundle of provider-side
// diagnostic helpers (telemetry redaction, error normalization) wired into the
// provider tree we drop. Only the type is consumed at our slice's boundary —
// `types.ts` re-exports it on the `AssistantMessage.diagnostics?` field. Pi's
// provider implementations (which we don't carry) populate it; with our custom
// Copilot streamFn we never emit diagnostics, so the runtime stays unused.
//
// We stub ONLY the types, mirroring the upstream field surface exactly, so any
// `AssistantMessage.diagnostics` value flowing through our worker code keeps
// the same shape. The upstream helpers (error normalization, diagnostic
// construction, append-to-message) are NOT carried — nothing in our slice
// calls them. If a future vendor sync needs them, re-copy
// `packages/ai/src/utils/diagnostics.ts` from the pinned commit in
// `../../PROVENANCE.md`.

export interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

export interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: Record<string, unknown>;
}
