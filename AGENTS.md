# github-router

A reverse proxy that exposes GitHub Copilot as OpenAI and Anthropic compatible API endpoints.

## Build, Lint, and Test Commands

- **Build:**
  `bun run build` (uses tsdown)
- **Dev:**
  `bun run dev`
- **Lint:**
  `bun run lint` (uses typescript-eslint + eslint-config-prettier)
- **Lint all:**
  `bun run lint:all`
- **Lint & Fix staged files:**
  `bunx lint-staged`
- **Test all:**
   `bun test`
- **Test single file:**
   `bun test tests/create-chat-completions.test.ts`
- **Typecheck:**
  `bun run typecheck`
- **Start (prod):**
  `bun run start`

## Code Style Guidelines

- **Imports:**
  Use ESNext syntax. Prefer absolute imports via `~/*` for `src/*` (see `tsconfig.json`).
- **Formatting:**
  Follows Prettier (with `prettier-plugin-packagejson`). Run `bun run lint` to auto-fix.
- **Types:**
  Strict TypeScript (`strict: true`). Avoid `any`; use explicit types and interfaces.
- **Naming:**
  Use `camelCase` for variables/functions, `PascalCase` for types/classes.
- **Error Handling:**
  Use explicit error classes (see `src/lib/error.ts`). Avoid silent failures.
- **Unused:**
  Unused imports/variables are errors (`noUnusedLocals`, `noUnusedParameters`).
- **Switches:**
  No fallthrough in switch statements.
- **Modules:**
  Use ESNext modules, no CommonJS.
- **Testing:**
   Use Bun's built-in test runner. Place tests in `tests/`, name as `*.test.ts`.
- **Linting:**
  Uses `typescript-eslint` + `eslint-config-prettier`. Includes TypeScript-aware linting and consistent formatting.
- **Paths:**
  Use path aliases (`~/*`) for imports from `src/`.
