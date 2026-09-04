# Retired subagent: `critic` (former fast profile role)

The native `critic` role was previously emitted as a fast-profile-only subagent on `gemini-3.8-flash` at medium effort.

In the approved profile architecture:
- Fast profile native roster is streamlined to `Explore` (Luna/high), `Plan` (Sol/high), `general-purpose` (Luna/max), `implementer` (Gemini 3.8 Flash/high), and `reviewer` (Grok 4.6/medium).
- There is no separate `critic` subagent in Fast; Gemini 3.8 Flash directly powers the native `implementer` role at high effort.
- The standalone fast-critic role is retired and no longer emitted in the native roster.

**Verdict: retired in favor of balanced native implementer/reviewer roles.**
