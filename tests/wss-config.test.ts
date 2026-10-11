import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

describe("WSS import generator", () => {
  it("exports only an RSA-2048 public key and explicit DC mapping", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crossgram-wss-json-"));
    try {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = path.join(dir, "public.pem");
      await writeFile(pem, publicKey.export({ type: "spki", format: "pem" }));
      const run = () => spawnSync(process.execPath, ["scripts/wss-config.mjs", pem], { encoding: "utf8" });
      const result = run();
      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.transport).toBe("websocket");
      expect(json.websocket_url).toBe("wss://x.wmc.de5.net/mtproto");
      expect(json.enable_special_config).toBe(false);
      expect(json.dcs).toEqual([1, 2, 3, 4, 5].map(id => ({ id })));
      expect(json).not.toHaveProperty("host");
      expect(json.rsa_key).not.toContain("PRIVATE");
      expect(createPublicKey(json.rsa_key).export({ type: "spki", format: "pem" }))
        .toBe(publicKey.export({ type: "spki", format: "pem" }));
      for (const url of ["ws://x.example.test/mtproto", "wss://127.0.0.1/mtproto", "wss://x.example.test", "wss://@x.example.test/mtproto", "wss://x.example.test/a#", "wss://x.example.test:0/a"]) {
        expect(spawnSync(process.execPath, ["scripts/wss-config.mjs", pem, url]).status).not.toBe(0);
      }
      await writeFile(pem, privateKey.export({ type: "pkcs8", format: "pem" }));
      expect(run().status).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
