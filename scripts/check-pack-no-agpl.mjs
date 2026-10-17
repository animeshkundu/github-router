#!/usr/bin/env node
// Release guard for the npm tarball's licensing surface, in both directions:
//
//  1. FAIL if it would ever contain AGPL / CloudCLI content, or if the package
//     license drifts from MIT. github-router launches CloudCLI (AGPL-3.0) as a
//     separate runtime-installed process and must NEVER ship any of its
//     source/binary inside the MIT-licensed package (see NOTICE).
//  2. FAIL if the notices the artifact OWES would be missing from it. The
//     package bundles the vendored Pi runtime into `dist/`, so MIT's "included
//     in all copies" clause applies to what npm publishes, not to the repo.
//
// Deterministic + npm-independent: the tarball is governed by package.json
// `files` plus npm's always-included set. We enumerate those paths and check
// them. This avoids parsing `npm pack --json`, whose stdout framing varies
// across npm versions / CI.
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

// npm always includes package.json, README*, and LICENSE*/LICENCE*, and
// NOTHING else. NOTICE and CHANGELOG.md are NOT in that set. Measured on this
// repo (`npm pack --dry-run --json`): with NOTICE absent from `files`, the
// tarball held only LICENSE, README.md, package.json, dist/**, and the two
// named docs. So a notice the artifact owes has to be named in `files`, which
// is why `files` lists NOTICE, and why the check below asserts it actually
// resolves rather than trusting that list to stay correct.
const alwaysIncluded = ["package.json", "README.md", "LICENSE", "LICENCE"];
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

// The bundled-vendor side. `dist/` contains the vendored Pi runtime, so the
// published artifact redistributes MIT-licensed code and must carry its notice.
// The source of that text is src/vendor/pi/LICENSE, which `files` deliberately
// does not ship; NOTICE carries a copy. Asserting the copyright line here is
// what makes a future `files` edit (or a NOTICE rewrite) fail loudly at release
// time instead of publishing an artifact with the attribution stripped.
if (!shipped.includes("NOTICE")) {
  fail(
    'the tarball would not contain NOTICE, which carries the MIT notice for the '
      + 'vendored Pi runtime bundled into dist/; keep "NOTICE" in package.json "files"',
  );
}
const notice = fs.readFileSync(path.join(ROOT, "NOTICE"), "utf8");
if (!notice.includes("Copyright (c) 2025 Mario Zechner")) {
  fail(
    "NOTICE no longer carries the vendored Pi runtime's upstream copyright "
      + "(src/vendor/pi/LICENSE); MIT requires that notice in every distributed copy",
  );
}
if (!/pi-mono/.test(notice)) {
  fail("NOTICE no longer names the vendored Pi runtime's upstream source");
}

console.log(
  `✅ pack-guard: ${shipped.length} files across [${entries.join(", ")}], license MIT, `
    + "no AGPL/CloudCLI content, vendored-Pi notice present.",
);
