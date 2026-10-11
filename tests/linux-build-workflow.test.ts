import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Linux packer signing header visibility", () => {
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
