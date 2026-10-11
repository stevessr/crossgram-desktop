import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

const canRun = process.platform !== "win32" &&
  spawnSync("bash", ["--version"]).status === 0 &&
  spawnSync("openssl", ["version"]).status === 0;

describe.skipIf(!canRun)("Linux update signing key preflight", () => {
  function run(buildOnly: boolean, updateKey = "") {
    const temporary = mkdtempSync(join(tmpdir(), "crossgram-signing-"));
    try {
      const script = fileURLToPath(new URL("../scripts/ci/prepare-update-key.sh", import.meta.url));
      const result = spawnSync("bash", ["-c",
        'source "$1" && openssl rsa -in "$UPDATE_KEY_FILE" -text -noout | head -n 1 && ' +
        'if [ -n "$UPDATE_PUBLIC_KEY_FILE" ]; then openssl rsa -RSAPublicKey_in -in "$UPDATE_PUBLIC_KEY_FILE" -noout -modulus >/dev/null; fi',
        "_", script,
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: temporary,
          BUILD_ONLY: String(buildOnly),
          UPDATE_KEY: updateKey,
          GITHUB_STEP_SUMMARY: join(temporary, "summary"),
        },
      });
      let summary = "";
      try { summary = readFileSync(join(temporary, "summary"), "utf8"); } catch { /* absent for non-build-only */ }
      return { ...result, summary };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  it("generates a valid 1024-bit disposable pair for manual builds", () => {
    const result = run(true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1024 bit");
    expect(result.summary).toContain("disposable RSA-1024");
  });

  it("rejects an RSA-2048 production key before compiling", () => {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    const result = run(false, pair.privateKey);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires RSA-1024");
  });

  it("rejects an unrelated RSA-1024 production secret", () => {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 1024,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    const result = run(false, pair.privateKey);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match");
  });

  it("rejects a missing production key", () => {
    const result = run(false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CROSSGRAM_UPDATE_KEY is required");
  });
});
