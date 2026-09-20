import { describe, expect, test } from "bun:test";

import {
  OCTOCODE_VERSION,
  currentOctocodePlatform,
  octocodeAssetName,
  octocodeExeName,
  octocodeReleaseUrl,
} from "../src/lib/octocode/manifest";

describe("octocode manifest", () => {
  test("version is pinned", () => {
    expect(OCTOCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("platform mapping covers major targets", () => {
    expect(currentOctocodePlatform("linux", "x64")).toBe("linux-x64");
    expect(currentOctocodePlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentOctocodePlatform("win32", "x64")).toBe("win32-x64");
    expect(currentOctocodePlatform("win32", "arm64")).toBeNull();
  });

  test("asset names + release URLs are well-formed", () => {
    const url = octocodeReleaseUrl("darwin-arm64");
    expect(url).toContain("Muvon/octocode");
    expect(url).toContain(OCTOCODE_VERSION);
    expect(octocodeAssetName("win32-x64")).toEndWith(".zip");
    expect(octocodeAssetName("linux-x64")).toEndWith(".tar.gz");
  });

  test("exe name is platform-correct", () => {
    expect(octocodeExeName("win32")).toBe("octocode.exe");
    expect(octocodeExeName("linux")).toBe("octocode");
  });
});
