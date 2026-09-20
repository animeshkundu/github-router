/**
 * octocode binary manifest — version pin + per-platform asset names.
 *
 * octocode ships a single static Rust binary per platform via GitHub
 * Releases (https://github.com/Muvon/octocode/releases). We pin a
 * known-good version; bumping it is a deliberate, reviewed change.
 * SHA verification is best-effort: release assets do not publish a
 * checksums file today, so we verify byte-size + smoke test (`--version`)
 * instead of failing closed on a missing digest (unlike the ColBERT
 * provisioner which has hardcoded SHAs).
 */

export const OCTOCODE_VERSION = "0.12.0";

export const OCTOCODE_REPO = "Muvon/octocode";

export type OctocodePlatform =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "win32-x64";

export function currentOctocodePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): OctocodePlatform | null {
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return null;
}

/**
 * Release asset file name for a platform. octocode release artifacts are
 * named `octocode-<target>.<ext>` where target is the Rust triple.
 */
export function octocodeAssetName(p: OctocodePlatform): string {
  switch (p) {
    case "linux-x64":
      return "octocode-x86_64-unknown-linux-gnu.tar.gz";
    case "linux-arm64":
      return "octocode-aarch64-unknown-linux-gnu.tar.gz";
    case "darwin-x64":
      return "octocode-x86_64-apple-darwin.tar.gz";
    case "darwin-arm64":
      return "octocode-aarch64-apple-darwin.tar.gz";
    case "win32-x64":
      return "octocode-x86_64-pc-windows-msvc.zip";
  }
}

export function octocodeReleaseUrl(p: OctocodePlatform): string {
  return `https://github.com/${OCTOCODE_REPO}/releases/download/v${OCTOCODE_VERSION}/${octocodeAssetName(p)}`;
}

export function octocodeExeName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "octocode.exe" : "octocode";
}
