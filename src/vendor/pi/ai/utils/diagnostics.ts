// VENDOR STUB (github-router): the upstream `utils/diagnostics.ts` exports a
// `AssistantMessageDiagnostic` type plus a small bundle of provider-side
// diagnostic helpers (telemetry redaction, error normalization) wired into the
// provider tree we drop. Only the type is consumed at our slice's boundary —
// `types.ts` re-exports it on the `AssistantMessage.diagnostics?` field. Pi's
// provider implementations (which we don't carry) populate it; with our custom
// Copilot streamFn we never emit diagnostics, so the runtime stays unused.
//
// We stub the type as a shallow shape that matches the upstream payload so any
// `AssistantMessage.diagnostics` value flowing through our worker code keeps
// the same field surface. If a future vendor sync wants the full helpers,
// re-copy `packages/ai/src/utils/diagnostics.ts` from the pinned commit in
// `../../PROVENANCE.md`.

export interface AssistantMessageDiagnostic {
	level: "info" | "warning" | "error";
	source?: string;
	code?: string;
	message: string;
	details?: Record<string, unknown>;
}
