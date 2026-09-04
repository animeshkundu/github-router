# Agency Hub hook isolation

## Incident

On 2026-09-04, a long-lived `github-router claude -m max` session began printing HTTP 404 errors for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`. Its isolated `settings.json` still pointed at an Agency Hub hook UUID captured at 16:40 UTC. Agency restarted at 18:11 UTC, installed a new UUID in the canonical `~/.claude/settings.json`, and returned 404 for the previous UUID while continuing to listen on the same port.

Agency injects fourteen Claude Code hooks to report session status, prompt/tool outcomes, subagents, notifications, and permission requests to its Hub. These hooks are not part of github-router inference, MCP, artifact review, or ai-or-die sticky-note binding.

## Defect class

A one-way configuration snapshot inherited an external integration endpoint whose identity rotates during the snapshot's lifetime. Updating the canonical source cannot repair already-running snapshots.

## Resolution

`ensureClaudeConfigMirror()` snapshot-copies the user's Claude configuration as before, then removes Agency's generated hook cohort from only the per-launch `settings.json`. Provenance requires Agency's localhost `/hook/<uuid>` shape plus its SessionStart curl signature or complete HTTP event cohort. Once a port is identified, mixed-nonce residue on that port is removed too. Other user hooks and settings are preserved.

The filter runs before github-router adds its own hooks. It covers both `github-router claude` and `github-router serve`; `start --cc` owns no mirror and is unaffected. The canonical `~/.claude/settings.json` is never modified, so plain Claude sessions continue to report to Agency Hub and use its remote approvals. Proxied sessions intentionally do not.

No watcher or relay was added. Live-syncing the canonical settings would weaken credential/config isolation and race the router's own atomic writes; relaying every Agency event would make github-router own a foreign integration lifecycle.

## Regression proof

- A realistic Windows/POSIX Agency hook cohort is removed on default or custom ports.
- A complete HTTP cohort is recognized when SessionStart is absent.
- Partial/lookalike localhost hooks are preserved.
- Mixed old/new nonces on an Agency-owned port are removed.
- The canonical settings file remains unchanged while its launch mirror is filtered.
- Concurrent mirror provisions tolerate torn reads and Windows `EPERM`/`EBUSY` rename races.
