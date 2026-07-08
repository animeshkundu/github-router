#!/usr/bin/env node
// Release guard: fail if the npm tarball would ever contain AGPL / CloudCLI
// content, or if the package license drifts from MIT. github-router launches
// CloudCLI (AGPL-3.0) as a separate runtime-installed process and must NEVER
// ship any of its source/binary inside the MIT-licensed package (see NOTICE).
//
// Runs `npm pack --dry-run --json` and inspects the file list. Exits non-zero
// on any violation so the release workflow blocks before publish.
import { execSync } from "node:child_process";
import fs from "node:fs";

const FORBIDDEN = [
  /(^|\/)vendor\/cloudcli(\/|$)/i,
  /(^|\/)cloudcli(\/|$)/i,
  /claudecodeui/i,
  /@cloudcli-ai/i,
];

function fail(msg) {
  console.error(`❌ pack-guard: ${msg}`);
  process.exit(1);
}

// 1. license must stay MIT
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.license !== "MIT") fail(`package.json license is "${pkg.license}", expected "MIT"`);

// 2. the tarball file list must contain no AGPL/CloudCLI paths
let out;
try {
  // Shell-resolved so Windows PATHEXT finds npm.cmd. No user input in the
  // command string, so this is injection-safe.
  out = execSync("npm pack --dry-run --json --ignore-scripts", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  fail(`npm pack --dry-run failed: ${String(e).slice(0, 200)}`);
}
let parsed;
try {
  parsed = JSON.parse(out);
} catch {
  fail("could not parse `npm pack --dry-run --json` output");
}
const files = (parsed?.[0]?.files ?? []).map((f) => f.path);
const offenders = files.filter((p) => FORBIDDEN.some((re) => re.test(p)));
if (offenders.length) {
  fail(`tarball would ship AGPL/CloudCLI content:\n  ${offenders.join("\n  ")}`);
}

console.log(`✅ pack-guard: ${files.length} files, license MIT, no AGPL/CloudCLI content.`);
