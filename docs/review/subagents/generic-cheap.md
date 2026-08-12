# Renamed subagent: `generic-cheap`

`generic-cheap` is the retired name of [`general-purpose-fast`](general-purpose-fast.md). The underlying single-entry Luna resolver was renamed from `genericCheapModel()` to `generalPurposeFastModel()`; its model, 1M floor, full toolset, and drop-not-downgrade behavior are unchanged.

The rename reflects measured reality rather than a new implementation. Luna was both the lowest-cost live-catalog model and the fastest measured catch-all candidate, so a cost-only name understated the route while `generic-fast` duplicated it with a dominated model chain. The new description also carries the `Use proactively` trigger idiom that the former generic descriptions lacked.

The retired name remains permanently in `PEER_AGENT_MD_FILENAME` so stale `.md` files from crashed older sessions remain sweepable.

**Verdict: renamed to `general-purpose-fast`.**
