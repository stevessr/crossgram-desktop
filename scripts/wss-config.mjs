#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { isIP } from "node:net";

const [pemPath, url = "wss://x.wmc.de5.net/mtproto"] = process.argv.slice(2);
if (!pemPath) throw new Error("Usage: node scripts/wss-config.mjs PUBLIC-KEY.pem [wss-url]");
const keyText = readFileSync(pemPath, "utf8");
if (/PRIVATE KEY/.test(keyText)) throw new Error("Provide a public PEM, never a private key.");
const key = createPublicKey(keyText);
if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 2048) {
  throw new Error("MTProto requires the server's RSA-2048 public key.");
}
const parsed = new URL(url);
const authority = /^wss:\/\/([^/?#]+)\//i.exec(url)?.[1];
const labels = parsed.hostname.split(".");
if (!authority || authority.includes("@") || authority.endsWith(":")
  || parsed.protocol !== "wss:" || parsed.username || parsed.password || url.includes("#")
  || /[\s\\\x00-\x1f\x7f]/u.test(url) || /%(?![a-f\d]{2})/i.test(url)
  || url.length > 4096 || isIP(parsed.hostname) || labels.length < 2
  || parsed.hostname.length > 253 || (parsed.port && Number(parsed.port) < 1)
  || labels.some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
  throw new Error("Provide a strict wss DNS URL with an explicit path, no credentials or fragment.");
}
process.stdout.write(JSON.stringify({
  name: "CrossGram WSS",
  transport: "websocket",
  websocket_url: url,
  rsa_key: key.export({ type: "pkcs1", format: "pem" }),
  enable_special_config: false,
  dcs: [1, 2, 3, 4, 5].map(id => ({ id })),
}, null, 2) + "\n");
