/**
 * The two halves of the redaction contract that surrounds a local consult.
 *
 * A leaf module on purpose: these strings are prompt text, and the prompt
 * builders (`claude-md-injection`, `codex-mcp-config`) must be able to embed
 * them without importing `local-egress`, which drags the Copilot service layer
 * into launch-time prose generation. `local-egress` re-exports both, so a
 * caller that already holds the egress graph imports them from there.
 *
 * Nothing here names the endpoint, a model, a window or an effort: the
 * instruction is about what the caller puts in the brief, and it must read the
 * same on every front-end.
 */

/**
 * One line on every caller-facing local-consult surface: redact before you
 * write.
 *
 * A prompt instruction, not a filter. The proxy cannot tell a credential from
 * an identifier, so a mechanical scrub would either miss secrets or corrupt the
 * code excerpts the consult depends on; the caller is the only party holding
 * the context that distinguishes them. It names the shapes that matter and
 * nothing about the endpoint, so it reads the same on the Advisor, the Oracle,
 * and both of their consultants' own prompts.
 */
export const LOCAL_CONSULT_REDACTION_LINE =
  "Replace every credential, token, key, password, and connection string with a placeholder, and keep secret file contents out of the transcript: the consultant needs the shape of the problem, never the value."

/**
 * The consultant half of {@link LOCAL_CONSULT_REDACTION_LINE}.
 *
 * Both sides carry it because the instruction is only half a contract on one
 * side: a consultant that asks for the real value would undo the caller's care,
 * and a consultant that treats a placeholder as a literal string would answer
 * the wrong question.
 */
export const LOCAL_CONSULT_REDACTION_NOTE =
  "Any credential in the material you receive has been replaced with a placeholder; treat it as an unknown value and do not ask for the real one."
