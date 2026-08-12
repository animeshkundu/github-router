# Architecture

`src/parser.ts` owns external string validation. `src/service.ts` owns the active service configuration and connectivity probe. `src/retry.ts` owns retry timing and terminal-error behavior. Public exports live in `src/index.ts`.
