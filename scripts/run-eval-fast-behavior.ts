import { spawn } from "node:child_process"

interface Scenario {
  name: string
  prompt: string
  planMode?: boolean
}

const scenarios: Scenario[] = [
  {
    name: "1. Negative Control: Single-file trivial edit",
    prompt: "Rename the local variable `raw` to `input` in src/parser.ts and update nothing else. Do not delegate.",
  },
  {
    name: "2. Complex Architecture in Plan Mode",
    prompt: "Design a complete architectural migration from numeric retry errors to structured diagnostics across callers, including ordering, interface boundaries, and runnable acceptance criteria.",
    planMode: true,
  },
  {
    name: "3. Behavior-changing Multi-file Implementation",
    prompt: "Add an exported formatAttempt helper with custom retry policies, update the retry logic in src/retry.ts, and add a test in tests/retry.test.ts.",
  },
  {
    name: "4. Deep Conceptual Technical Fork (Oracle candidate)",
    prompt: "We have an architectural fork between using an in-memory queue versus file-backed WAL for cross-process synchronization under Windows file-locking constraints. The repository tests cannot settle this. Compare the two designs and recommend one.",
  },
  {
    name: "5. Trajectory & Framing Check (Advisor candidate)",
    prompt: "I feel our current session implementation might be drifting from our initial performance goals and focusing too much on error envelopes. Can you review our trajectory and advise on direction?",
  },
]

async function runScenario(s: Scenario) {
  console.log(`\n======================================================`);
  console.log(`RUNNING: ${s.name}`);
  console.log(`Prompt: "${s.prompt}"`);
  console.log(`Plan Mode: ${Boolean(s.planMode)}`);
  console.log(`======================================================\n`);

  const args = [
    "run",
    "src/main.ts",
    "claude",
    "-m", "fast",
    "--no-auto-update",
    "--no-update-check",
    "--no-self-update",
    "--",
    "--print",
    "--verbose",
    "--output-format", "stream-json",
    ...(s.planMode ? ["--permission-mode", "plan"] : ["--permission-mode", "dontAsk"]),
    s.prompt
  ]

  return new Promise<void>((resolve) => {
    const child = spawn("bun", args, {
      cwd: process.cwd(),
      env: { ...process.env, GH_ROUTER_NO_SELF_UPDATE: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    })

    const actions: Array<{ tool: string; input: unknown }> = []

    child.stdout.on("data", (chunk) => {
      const lines = chunk.toString().split("\n")
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue
        try {
          const json = JSON.parse(line)
          if (json.type === "tool_use" || (json.type === "content_block_start" && json.content_block?.type === "tool_use")) {
            const tool = json.name || json.content_block?.name
            actions.push({ tool, input: json.input || json.content_block?.input })
            console.log(`[OBSERVED TOOL CALL]: ${tool}`);
          } else if (json.type === "server_tool_use") {
            actions.push({ tool: json.name, input: json.input })
            console.log(`[OBSERVED SERVER TOOL CALL]: ${json.name}`);
          }
        } catch {
          // ignore non-json
        }
      }
    })

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString()
      if (text.includes("fast Advisor dispatch") || text.includes("Peer MCP") || text.includes("oracle")) {
        console.log(`[STDERR LOG]: ${text.trim()}`);
      }
    })

    const timer = setTimeout(() => {
      console.log(`[TIMEOUT]: Killing scenario after 45s`);
      child.kill()
    }, 45000)

    child.on("close", (code) => {
      clearTimeout(timer)
      console.log(`\nScenario finished with exit code ${code}`);
      console.log(`Total actions observed: ${actions.length}`);
      actions.forEach((a, i) => {
        console.log(`  ${i + 1}. ${a.tool} ${a.input ? JSON.stringify(a.input).slice(0, 100) : ""}`);
      })
      resolve()
    })
  })
}

async function main() {
  for (const s of scenarios) {
    await runScenario(s)
  }
}

main().catch(console.error)
