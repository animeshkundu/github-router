# Delegation fixture service

A deliberately small TypeScript service used only by the opt-in delegation evaluation. It parses a port, stores runtime configuration, and retries a connectivity probe.

```ts
import { loadConfig } from "./src"

loadConfig({ port: "8787", retry: { attempts: 3, delayMs: 20 } })
```
