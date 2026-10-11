import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Linux packer signing header visibility", () => {
  it("preflights signing keys and injects the matching disposable public key", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow).toContain('source "$patcher/scripts/ci/prepare-update-key.sh"');
    expect(workflow).toContain('public_key_args=(--update-public-key-file "$UPDATE_PUBLIC_KEY_FILE")');
    expect(workflow).toContain('"${public_key_args[@]}"');
    expect(workflow).not.toContain('openssl genrsa -out "$UPDATE_KEY_FILE" 2048');
    // Upstream Packer writes tlinuxupd<version> into its CWD, not -path.
    expect(workflow).toContain('-w "/work/artifacts/payload-work-$brand"');
    expect(workflow).toContain('payload_source="$payload_work/tlinuxupd$crossgram_version"');
  });

  it("mounts generated sibling headers read-only into the compilation container", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    const build = workflow.slice(workflow.indexOf('            cd "$source"'), workflow.indexOf('            binary="$source/out/Release/$product"'));
    expect(build).toContain('private_dir="$(dirname "$source")/DesktopPrivate"');
    expect(build).toContain('test -s "$private_dir/packer_private.h"');
    expect(build).toContain('test -s "$private_dir/alpha_private.h"');
    expect(build).toContain('-v "$private_dir:/usr/src/DesktopPrivate:ro"');
    expect(build).toContain('-v "$PWD:/usr/src/tdesktop"');
    expect(build).toContain('crossgram-tdesktop-build');
  });
});

describe("Linux compiler cache", () => {
  it("restores across builds and saves objects even after a failed compile", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow).toContain("actions/cache/restore@v6");
    expect(workflow).toContain("actions/cache/save@v6");
    expect(workflow).toContain("if: always() && runner.os == 'Linux'");
    expect(workflow).toContain('compiler_cache="$GITHUB_WORKSPACE/work/ccache"');
    expect(workflow).toContain('-v "$compiler_cache:/usr/src/ccache"');
    expect(workflow).toContain("-e CCACHE_DIR=/usr/src/ccache");
    expect(workflow).toContain("-e CCACHE_MAXSIZE=2G");
  });

  it("only enables caching on Telegram and excludes the private signing Packer", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    const linux = workflow.slice(
      workflow.indexOf("      - name: Build, smoke test, and package Linux brands"),
      workflow.indexOf("      - name: Save Linux C++ compiler cache"),
    );
    expect(linux).toContain('anchor = "add_executable(Telegram WIN32 MACOSX_BUNDLE)"');
    expect(linux).toContain("set_property(TARGET Telegram PROPERTY CXX_COMPILER_LAUNCHER ccache)");
    expect(linux).toContain("set_property(TARGET Telegram PROPERTY C_COMPILER_LAUNCHER ccache)");
    expect(linux).toContain("            enable_compiler_cache");
    expect(linux).not.toContain("CMAKE_CXX_COMPILER_LAUNCHER=ccache");
    expect(linux).not.toContain("set_property(TARGET Packer PROPERTY CXX_COMPILER_LAUNCHER ccache)");
  });
});
