// VENDOR HEADER (github-router). The exports below are upstream's own, verbatim:
// at v1.3.0 `packages/agent/src/` is exactly these six files `(agent, agent-loop,
// index, proxy, stream-fn, types)`, and its `index.ts` re-exports those five and
// nothing else. The `harness/` subtree and `node.ts` that earlier pins carried
// here were not dropped by us — upstream moved them out of this package to
// `packages/durable/src/harness` and `packages/chord/src/node.ts`, so they are
// simply outside the slice this repo vendors.
//
// If a future need for the harness appears, pull it from the tag recorded in
// `../PROVENANCE.md`; do not re-author it here.
//
// See `../PROVENANCE.md` for the pinned upstream revision and divergences.

export * from "./agent.ts";
export * from "./agent-loop.ts";
export * from "./proxy.ts";
export { setDefaultStreamFn } from "./stream-fn.ts";
export * from "./types.ts";
