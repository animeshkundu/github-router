/**
 * Toolbelt manifest: pinned versions, download URLs and SHA256 digests
 * for the curated CLI tools provisioned onto the spawned agent's PATH.
 *
 * The SHA256 values are hardcoded HERE (not fetched from the same
 * release at runtime) so a tampered/republished upstream release cannot
 * defeat verification. Regenerate with `bun run
 * scripts/gen-toolbelt-manifest.ts` when re-pinning; the script
 * downloads each asset and recomputes the digest.
 *
 * `rg` is intentionally NOT in this manifest — it is materialized from
 * the already-installed `@vscode/ripgrep` binary (see provision.ts), so
 * we never download ripgrep twice.
 *
 * `tokei` is intentionally excluded — upstream stopped publishing
 * prebuilt release binaries (v13+ releases carry no assets).
 */

export type ArchiveKind = "raw" | "zip" | "tar.gz"

export interface ToolAsset {
  url: string
  /** SHA256 of the downloaded archive/binary (hex). Verified before extraction. */
  sha256: string
  archive: ArchiveKind
}

export interface ToolSpec {
  /** Primary command name; also the gap-fill probe target. */
  command: string
  /** Binary basename inside the archive (no extension). */
  binBasename: string
  /** Extra bin filenames to also materialize as copies (e.g. `sg`). */
  aliases?: string[]
  /** Keyed `"<platform>-<arch>"`, e.g. `win32-x64`, `darwin-arm64`. */
  assets: Record<string, ToolAsset>
}

export function platformArchKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`
}

export function assetFor(
  spec: ToolSpec,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ToolAsset | undefined {
  return spec.assets[platformArchKey(platform, arch)]
}

export const TOOLBELT_TOOLS: ToolSpec[] = [
  {
    command: "fd",
    binBasename: "fd",
    assets: {
      "win32-x64": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-x86_64-pc-windows-msvc.zip",
        sha256: "b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8",
        archive: "zip",
      },
      "win32-arm64": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-aarch64-pc-windows-msvc.zip",
        sha256: "4f9110c2d5b33a7f760bfa5510f4c113d828109f7277d421b1053a9943c0fc92",
        archive: "zip",
      },
      "darwin-arm64": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-aarch64-apple-darwin.tar.gz",
        sha256: "623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a",
        archive: "tar.gz",
      },
      "linux-x64": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-x86_64-unknown-linux-musl.tar.gz",
        sha256: "e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde",
        archive: "tar.gz",
      },
      "linux-arm64": {
        url: "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-aarch64-unknown-linux-musl.tar.gz",
        sha256: "f32d3657473fba74e2600babc8db0b93420d51169223b7e8143b2ed55d8fd9e8",
        archive: "tar.gz",
      },
    },
  },
  {
    command: "sd",
    binBasename: "sd",
    assets: {
      "win32-x64": {
        url: "https://github.com/chmln/sd/releases/download/v1.1.0/sd-v1.1.0-x86_64-pc-windows-msvc.zip",
        sha256: "59837c2e7c911099aca1cc46b663bcdc5a949fd3e9fbbaf34fc73e5d5d71007c",
        archive: "zip",
      },
      "darwin-x64": {
        url: "https://github.com/chmln/sd/releases/download/v1.1.0/sd-v1.1.0-x86_64-apple-darwin.tar.gz",
        sha256: "1fca1e9c91813a8aac6821063c923107ba0f66a83309e095edcd3b202f67f97e",
        archive: "tar.gz",
      },
      "darwin-arm64": {
        url: "https://github.com/chmln/sd/releases/download/v1.1.0/sd-v1.1.0-aarch64-apple-darwin.tar.gz",
        sha256: "4bd3c09226376ca0a1d69589c91e86276fae36c5fbaaee669afce583f6682030",
        archive: "tar.gz",
      },
      "linux-x64": {
        url: "https://github.com/chmln/sd/releases/download/v1.1.0/sd-v1.1.0-x86_64-unknown-linux-musl.tar.gz",
        sha256: "02f00f4777d43e8e95b7b8d49e1a0d6e502fed4b8e79c1c8b8063857a30caa2e",
        archive: "tar.gz",
      },
      "linux-arm64": {
        url: "https://github.com/chmln/sd/releases/download/v1.1.0/sd-v1.1.0-aarch64-unknown-linux-musl.tar.gz",
        sha256: "ec8c93c0533ff21f4851d11566808d4082544baf063d9b96ea77c27e98b7cd99",
        archive: "tar.gz",
      },
    },
  },
  {
    command: "jq",
    binBasename: "jq",
    assets: {
      "win32-x64": {
        url: "https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-windows-amd64.exe",
        sha256: "23cb60a1354eed6bcc8d9b9735e8c7b388cd1fdcb75726b93bc299ef22dd9334",
        archive: "raw",
      },
      "darwin-x64": {
        url: "https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-macos-amd64",
        sha256: "e80dbe0d2a2597e3c11c404f03337b981d74b4a8504b70586c354b7697a7c27f",
        archive: "raw",
      },
      "darwin-arm64": {
        url: "https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-macos-arm64",
        sha256: "a9fe3ea2f86dfc72f6728417521ec9067b343277152b114f4e98d8cb0e263603",
        archive: "raw",
      },
      "linux-x64": {
        url: "https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-amd64",
        sha256: "020468de7539ce70ef1bceaf7cde2e8c4f2ca6c3afb84642aabc5c97d9fc2a0d",
        archive: "raw",
      },
      "linux-arm64": {
        url: "https://github.com/jqlang/jq/releases/download/jq-1.8.1/jq-linux-arm64",
        sha256: "6bc62f25981328edd3cfcfe6fe51b073f2d7e7710d7ef7fcdac28d4e384fc3d4",
        archive: "raw",
      },
    },
  },
  {
    command: "yq",
    binBasename: "yq",
    assets: {
      "win32-x64": {
        url: "https://github.com/mikefarah/yq/releases/download/v4.53.2/yq_windows_amd64.exe",
        sha256: "2aee32f1de46a20672f48c25df3018839798bd509143f2ce05fdab1550ff5592",
        archive: "raw",
      },
      "win32-arm64": {
        url: "https://github.com/mikefarah/yq/releases/download/v4.53.2/yq_windows_arm64.exe",
        sha256: "448208550332ca33ef816e4cee49fc1e79987b8a08a451c6ae529703c8cfc8a9",
        archive: "raw",
      },
      "darwin-x64": {
        url: "https://github.com/mikefarah/yq/releases/download/v4.53.2/yq_darwin_amd64",
        sha256: "616b0a0f6a5b79d746f05a169c2b9bb40dee00c605ef165b9a1c1681bba738ac",
        archive: "raw",
      },
      "darwin-arm64": {
        url: "https://github.com/mikefarah/yq/releases/download/v4.53.2/yq_darwin_arm64",
        sha256: "541ba2287560df70f561955e2d7f7e1cd00cf2a15a884f6b5c87a4bfa887bc07",
        archive: "raw",
      },
      "linux-x64": {
        url: "https://github.com/mikefarah/yq/releases/download/v4.53.2/yq_linux_amd64",
        sha256: "d56bf5c6819e8e696340c312bd70f849dc1678a7cda9c2ad63eebd906371d56b",
        archive: "raw",
      },
      "linux-arm64": {
        url: "https://github.com/mikefarah/yq/releases/download/v4.53.2/yq_linux_arm64",
        sha256: "03061b2a50c7a498de2bbb92d7cb078ce433011f085a4994117c2726be4106ea",
        archive: "raw",
      },
    },
  },
  {
    command: "ast-grep",
    binBasename: "ast-grep",
    aliases: ["sg"],
    assets: {
      "win32-x64": {
        url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-x86_64-pc-windows-msvc.zip",
        sha256: "a4febbc8c48671e5729d85e29e4ebe5a051b7250d19545bca18e725ccf40ef61",
        archive: "zip",
      },
      "win32-arm64": {
        url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-aarch64-pc-windows-msvc.zip",
        sha256: "a519fdd90324bf6858fde2d3feb2b862d67b834dc11af8f5b6c2c8143ab6a6c5",
        archive: "zip",
      },
      "darwin-x64": {
        url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-x86_64-apple-darwin.zip",
        sha256: "6d703090b106747b2f56086b6ccc7e798fe78bcae70257aa20519b220153555b",
        archive: "zip",
      },
      "darwin-arm64": {
        url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-aarch64-apple-darwin.zip",
        sha256: "8c847d0a29aa4b3101b3361e0b3ee7fb53c7e497adc9ed1afc9615538cd40782",
        archive: "zip",
      },
      "linux-x64": {
        url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-x86_64-unknown-linux-gnu.zip",
        sha256: "a26253a9c821d935f7e383e40f0de7c2ca62a4121de1f73a6d81ec32eae631e0",
        archive: "zip",
      },
      "linux-arm64": {
        url: "https://github.com/ast-grep/ast-grep/releases/download/0.43.0/app-aarch64-unknown-linux-gnu.zip",
        sha256: "e706846148493967f3ab8011334817edd86ce5acbec10718b2a7b40799c640ff",
        archive: "zip",
      },
    },
  },
  {
    command: "scc",
    binBasename: "scc",
    assets: {
      "win32-x64": {
        url: "https://github.com/boyter/scc/releases/download/v3.7.0/scc_Windows_x86_64.zip",
        sha256: "97abf9d55d4b79d3310536d576ccbdf5017aeb425780e850336120b6e67622e1",
        archive: "zip",
      },
      "win32-arm64": {
        url: "https://github.com/boyter/scc/releases/download/v3.7.0/scc_Windows_arm64.zip",
        sha256: "fd114614c10382c9ed2e32d5455cc4b51960a9f71691c5c1ca42b31adea5b84d",
        archive: "zip",
      },
      "darwin-x64": {
        url: "https://github.com/boyter/scc/releases/download/v3.7.0/scc_Darwin_x86_64.tar.gz",
        sha256: "c3f7457856b9169ccb3c1dd14198e67f730bee065f24d9051bf52cdc2a719ecc",
        archive: "tar.gz",
      },
      "darwin-arm64": {
        url: "https://github.com/boyter/scc/releases/download/v3.7.0/scc_Darwin_arm64.tar.gz",
        sha256: "376cbae670be59ee64f398de20e0694ec434bf8a9b842642952b0ab0be5f3961",
        archive: "tar.gz",
      },
      "linux-x64": {
        url: "https://github.com/boyter/scc/releases/download/v3.7.0/scc_Linux_x86_64.tar.gz",
        sha256: "3d9d65b00ca874c2b29151abe7e1480736f5229edc3ce8e4b2791460cdfabf5a",
        archive: "tar.gz",
      },
      "linux-arm64": {
        url: "https://github.com/boyter/scc/releases/download/v3.7.0/scc_Linux_arm64.tar.gz",
        sha256: "dcb05c6e993bb2d8d2da4765ff018f2e752325dd205a41698929c55e4123575d",
        archive: "tar.gz",
      },
    },
  },
  {
    // difftastic ships its binary as `difft`.
    command: "difftastic",
    binBasename: "difft",
    assets: {
      "win32-x64": {
        url: "https://github.com/Wilfred/difftastic/releases/download/0.69.0/difft-x86_64-pc-windows-msvc.zip",
        sha256: "a5adbf57eb1b923b62d1c3596c4f827df143f5b52cfba48bb9e83f41dea90c02",
        archive: "zip",
      },
      "win32-arm64": {
        url: "https://github.com/Wilfred/difftastic/releases/download/0.69.0/difft-aarch64-pc-windows-msvc.zip",
        sha256: "fa709e803088b54774adf0111409483ee5edfbbc1f9dcc5610e81e4ed3841e53",
        archive: "zip",
      },
      "darwin-x64": {
        url: "https://github.com/Wilfred/difftastic/releases/download/0.69.0/difft-x86_64-apple-darwin.tar.gz",
        sha256: "5f5487e7a6e817194a1cef297d2ffb300454371635a4cde865087dbc064730a2",
        archive: "tar.gz",
      },
      "darwin-arm64": {
        url: "https://github.com/Wilfred/difftastic/releases/download/0.69.0/difft-aarch64-apple-darwin.tar.gz",
        sha256: "c958b87885a5825a356c5899ac7ecdd752a7942084199f2be4bc0bf8c9de8e33",
        archive: "tar.gz",
      },
      "linux-x64": {
        url: "https://github.com/Wilfred/difftastic/releases/download/0.69.0/difft-x86_64-unknown-linux-gnu.tar.gz",
        sha256: "038db96a0e8fce69f2554e33e04ff75fbf6f96ea45cb4edb9ed6203a2c4750ff",
        archive: "tar.gz",
      },
      "linux-arm64": {
        url: "https://github.com/Wilfred/difftastic/releases/download/0.69.0/difft-aarch64-unknown-linux-gnu.tar.gz",
        sha256: "abd2f42d2afd424312b4862aa7c7bb0320447670ae22fabcc5159db03e2dccbd",
        archive: "tar.gz",
      },
    },
  },
  {
    command: "gron",
    binBasename: "gron",
    assets: {
      "win32-x64": {
        url: "https://github.com/tomnomnom/gron/releases/download/v0.7.1/gron-windows-amd64-0.7.1.zip",
        sha256: "5ed427a4a504d8e03a1770b71d4ad16a3764179e085b5ae84e51a57b299f300d",
        archive: "zip",
      },
      "win32-arm64": {
        url: "https://github.com/tomnomnom/gron/releases/download/v0.7.1/gron-windows-arm64-0.7.1.zip",
        sha256: "9bd38a241f1afdbd3c8f952b92b7090e7a446cac5251bfed3fdf28f219c9dda8",
        archive: "zip",
      },
      "darwin-x64": {
        url: "https://github.com/tomnomnom/gron/releases/download/v0.7.1/gron-darwin-amd64-0.7.1.tgz",
        sha256: "59034d4aa883c5815784b290567d104669a51f20eaf97f1d8baa4f74e22047d6",
        archive: "tar.gz",
      },
      "darwin-arm64": {
        url: "https://github.com/tomnomnom/gron/releases/download/v0.7.1/gron-darwin-arm64-0.7.1.tgz",
        sha256: "1b9b987c6ead684a992db91b7a32fd15ef946013dfabfe84d00b2fa6f55d7182",
        archive: "tar.gz",
      },
      "linux-x64": {
        url: "https://github.com/tomnomnom/gron/releases/download/v0.7.1/gron-linux-amd64-0.7.1.tgz",
        sha256: "ca0335826b02b044fa05d7e951521e45c6ced1c381a73ed5803450088e18bf22",
        archive: "tar.gz",
      },
      "linux-arm64": {
        url: "https://github.com/tomnomnom/gron/releases/download/v0.7.1/gron-linux-arm64-0.7.1.tgz",
        sha256: "5d1d4764723a0f768d9ddef0685a052f564c8bbf5e475382342faf4224a07d80",
        archive: "tar.gz",
      },
    },
  },
]
