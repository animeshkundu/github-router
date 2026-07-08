#!/usr/bin/env node
// Release guard: fail if the npm tarball would ever contain AGPL / CloudCLI
// content, or if the package license drifts from MIT. github-router launches
// CloudCLI (AGPL-3.0) as a separate runtime-installed process and must NEVER
// ship any of its source/binary inside the MIT-licensed package (see NOTICE).
//
// Deterministic + npm-independent: the tarball is governed by package.json
// `files` (plus always-included package.json/README/LICENSE/NOTICE). We enumerate
// those paths and reject any that match a forbidden pattern. This avoids parsing
// `npm pack --json`, whose stdout framing varies across npm versions / CI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (pkg.license !== "MIT") fail(`package.json license is "${pkg.license}", expected "MIT"`);

// The set of top-level entries npm would consider for the tarball.
const alwaysIncluded = ["package.json", "README.md", "LICENSE", "NOTICE", "CHANGELOG.md"];
const entries = [...new Set([...(pkg.files ?? []), ...alwaysIncluded])];

// Collect every file path (repo-relative, forward slashes) that would ship.
const shipped = [];
function walk(rel) {
  const abs = path.join(ROOT, rel);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return; // entry doesn't exist locally (e.g. README) — nothing to ship
  }
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(abs)) walk(`${rel}/${child}`);
  } else {
    shipped.push(rel.split(path.sep).join("/"));
  }
}
for (const entry of entries) {
  // A forbidden entry NAME itself (e.g. someone adds "vendor/cloudcli" to files).
  if (FORBIDDEN.some((re) => re.test(entry.split(path.sep).join("/")))) {
    fail(`package.json "files" lists a forbidden path: ${entry}`);
  }
  walk(entry);
}

const offenders = shipped.filter((p) => FORBIDDEN.some((re) => re.test(p)));
if (offenders.length) {
  fail(`tarball would ship AGPL/CloudCLI content:\n  ${offenders.join("\n  ")}`);
}

console.log(
  `✅ pack-guard: ${shipped.length} files across [${entries.join(", ")}], license MIT, no AGPL/CloudCLI content.`,
);
