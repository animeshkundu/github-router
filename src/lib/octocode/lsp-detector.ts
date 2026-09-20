/**
 * LSP detector — map a workspace to the language servers it needs.
 *
 * Pure filesystem probing (no subprocess): checks for indicator files
 * (Cargo.toml, package.json, go.mod, ...) and representative source
 * extensions. Returns the octocode `--with-lsp` CSV value.
 *
 * Only servers octocode's MCP layer knows are emitted. Unknown
 * languages fall back to tree-sitter-only (no LSP) — never an error.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface LspDetection {
  /** octocode `--with-lsp` CSV, e.g. "rust-analyzer,typescript-language-server". Empty when none. */
  csv: string;
  /** Individual server binaries detected as needed. */
  servers: Array<string>;
  /** Human-readable languages found (for notices/debug). */
  languages: Array<string>;
}

interface LanguageRule {
  language: string;
  server: string;
  indicators: Array<string>;
  extensions: Array<string>;
}

const RULES: ReadonlyArray<LanguageRule> = [
  {
    language: "rust",
    server: "rust-analyzer",
    indicators: ["Cargo.toml", "Cargo.lock"],
    extensions: [".rs"],
  },
  {
    language: "typescript",
    server: "typescript-language-server",
    indicators: ["package.json", "tsconfig.json", "tsconfig.base.json"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  {
    language: "python",
    server: "pyright",
    indicators: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"],
    extensions: [".py"],
  },
  {
    language: "go",
    server: "gopls",
    indicators: ["go.mod", "go.sum"],
    extensions: [".go"],
  },
  {
    language: "java",
    server: "jdtls",
    indicators: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"],
    extensions: [".java"],
  },
  {
    language: "cpp",
    server: "clangd",
    indicators: ["CMakeLists.txt", "compile_commands.json", ".clangd"],
    extensions: [".cpp", ".cc", ".cxx", ".c", ".h", ".hpp"],
  },
  {
    language: "ruby",
    server: "ruby-lsp",
    indicators: ["Gemfile", "Gemfile.lock", ".ruby-version"],
    extensions: [".rb"],
  },
  {
    language: "php",
    server: "intelephense",
    indicators: ["composer.json", "composer.lock"],
    extensions: [".php"],
  },
];

function hasAnyFile(dir: string, names: ReadonlyArray<string>, maxDepth = 2): boolean {
  // Depth-0: workspace root. Depth-1: immediate subdirs (monorepo packages).
  // Bounded readdir walk — never a recursive glob.
  try {
    const roots: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
    while (roots.length > 0) {
      const cur = roots.pop();
      if (!cur) break;
      let entries: Array<string>;
      try {
        entries = readdirSync(cur.dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e === "node_modules" || e === ".git" || e === "target" || e === "dist") continue;
        const full = path.join(cur.dir, e);
        if (names.includes(e)) return true;
        if (cur.depth < maxDepth && names.some((n) => n.startsWith(".") && e === n)) return true;
        if (cur.depth < maxDepth - 1) {
          try {
            if (statSync(full).isDirectory()) roots.push({ dir: full, depth: cur.depth + 1 });
          } catch {
            // ignore
          }
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

function hasExtension(dir: string, exts: ReadonlyArray<string>): boolean {
  // Shallow probe: root + one level. Enough to detect language presence
  // without walking a monorepo.
  try {
    const checkDir = (d: string): boolean => {
      let entries: Array<string>;
      try {
        entries = readdirSync(d);
      } catch {
        return false;
      }
      for (const e of entries) {
        if (e === "node_modules" || e === ".git" || e === "target" || e === "dist") continue;
        if (exts.some((ext) => e.endsWith(ext))) return true;
      }
      return false;
    };
    if (checkDir(dir)) return true;
    let subdirs: Array<string> = [];
    try {
      subdirs = readdirSync(dir).filter((e) => {
        if (e === "node_modules" || e === ".git" || e === "target") return false;
        try {
          return statSync(path.join(dir, e)).isDirectory();
        } catch {
          return false;
        }
      }).slice(0, 20);
    } catch {
      return false;
    }
    return subdirs.some((s) => checkDir(path.join(dir, s)));
  } catch {
    return false;
  }
}

/**
 * Detect LSP servers needed for a workspace. Pure + synchronous (fs
 * probes only). Returns empty when the dir is missing or no language
 * matches.
 */
export function detectLspForWorkspace(workspace: string): LspDetection {
  const servers: Array<string> = [];
  const languages: Array<string> = [];
  let dir: string;
  try {
    dir = path.resolve(workspace);
  } catch {
    return { csv: "", servers, languages };
  }
  if (!existsSync(dir)) return { csv: "", servers, languages };

  for (const rule of RULES) {
    const byIndicator = hasAnyFile(dir, rule.indicators);
    const byExtension = !byIndicator && hasExtension(dir, rule.extensions);
    if (byIndicator || byExtension) {
      servers.push(rule.server);
      languages.push(rule.language);
    }
  }
  return { csv: servers.join(","), servers, languages };
}

export const __testing = { RULES };
