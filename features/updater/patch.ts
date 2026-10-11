import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { dirname, join } from "node:path";

import { PatchContext } from "../../src/core/patch-context.js";
import { PatchError } from "../../src/core/text-file.js";
import type { Target } from "../../src/targets.js";

/**
 * The generated per target/brand/platform feed. The client asks for
 * prefix/currentN, where N is Platform::AutoUpdateVersion(), so the publish
 * job writes current2/current3/current6 next to it.
 */
export const FEED_BASE =
  "https://raw.githubusercontent.com/crossgram-project/crossgram-desktop/updates";

/**
 * Crossgram build numbers stay above every upstream AppVersion, so an
 * available version is always newer than the running one, while an installed
 * Crossgram build recognises the payload of its own run.
 */
export const VERSION_BASE = 100_000_000;

export const VERSION_ROOT = "Telegram/SourceFiles/core/version.h";
export const CONFIG_ROOT = "Telegram/SourceFiles/config.h";
export const LOCALSTORAGE_ROOT = "Telegram/SourceFiles/storage/localstorage.cpp";
export const PACKER_ROOT = "Telegram/SourceFiles/_other/packer.cpp";
export const CMAKE_ROOT = "Telegram/CMakeLists.txt";

export type UpdatePlatform = "windows" | "linux" | "macos";

export interface UpdaterPatchOptions {
  readonly root: string;
  readonly target: Target;
  readonly brand: string;
  readonly platform: UpdatePlatform | null;
  readonly build: number | null;
  readonly featureRoot: string;
  /** RSA private key the CI injects into the upstream packer; optional. */
  readonly privateKey?: string | null;
  /** Optional matching public key for isolated build-only signing. */
  readonly publicKey?: string | null;
}

export interface TextPatch {
  readonly search: string;
  readonly replacement: string;
  /** A file that already contains this marker is left alone. */
  readonly marker: string;
}

export function crossgramVersion(build: number): number {
  if (!Number.isInteger(build) || build <= 0 || VERSION_BASE + build > 999_999_999) {
    throw new PatchError("Unsupported Crossgram build number " + build + ".");
  }
  return VERSION_BASE + build;
}

export function updatePrefix(
  target: string,
  brand: string,
  platform: UpdatePlatform,
): string {
  return FEED_BASE + "/" + target + "-" + brand + "/" + platform;
}

/** Reject incompatible keys before starting the expensive C++ build. */
export function validateUpdateKeyPair(privatePem: string, publicPem: string): void {
  try {
    const privateKey = createPrivateKey(privatePem);
    if (privateKey.asymmetricKeyType !== "rsa" ||
        privateKey.asymmetricKeyDetails?.modulusLength !== 1024) {
      throw new PatchError("Desktop update signing requires an RSA-1024 private key (128-byte signature).");
    }
    const derived = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    const trusted = createPublicKey(publicPem).export({ type: "spki", format: "der" });
    if (!derived.equals(trusted)) {
      throw new PatchError("Desktop update signing private key does not match the embedded public key.");
    }
  } catch (error) {
    if (error instanceof PatchError) throw error;
    const reason = error instanceof Error ? error.message : "unknown crypto error";
    throw new PatchError("Invalid desktop update RSA signing key pair (PEM): " + reason);
  }
}

/** Render a PEM the way the upstream sources spell their C++ literals. */
export function cppKeyLiteral(pem: string): string {
  const lines = pem.replaceAll("\r\n", "\n").trimEnd().split("\n");
  return "\\\n" + lines.map((line) => line + "\\n\\\n").join("");
}

/** constexpr auto AppVersion = <build>; - the version the updater compares. */
export function versionPatch(source: string, version: number): TextPatch {
  const match = /constexpr auto AppVersion = \d+;/.exec(source);
  if (!match) throw new PatchError("Could not find AppVersion in the version header.");
  const replacement = "constexpr auto AppVersion = " + version + ";";
  return { search: match[0], replacement, marker: replacement };
}

/** Both client-side update keys start trusting the Crossgram signature. */
export function updateKeyPatches(source: string, key: string): TextPatch[] {
  return keyPatches(source, "static const char \\*(?:UpdatesPublicKey|UpdatesPublicBetaKey) = ", key);
}

/** The upstream packer verifies its own output, so it needs the same key. */
export function packerKeyPatches(source: string, key: string): TextPatch[] {
  return keyPatches(source, "const char \\*(?:PublicKey|PublicBetaKey) = ", key);
}

function keyPatches(source: string, declaration: string, key: string): TextPatch[] {
  const pattern = new RegExp("(" + declaration + '")[\\s\\S]*?(";)', "g");
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0 || matches.length > 2) {
    throw new PatchError("Expected one or two update keys, found " + matches.length + ".");
  }
  return matches.map((match) => {
    const declaration = match[1] ?? "";
    const name = /UpdatesPublicKey|UpdatesPublicBetaKey|PublicBetaKey|PublicKey/.exec(declaration)?.[0] ?? "Key";
    const marker = "// CROSSGRAM: Crossgram update key (" + name + ").";
    const replacement = marker + "\n" + declaration + key + (match[2] ?? "");
    return { search: match[0], replacement, marker };
  });
}

/** The upstream packer target only exists for special builds. */
export function packerTargetPatch(source: string): TextPatch {
  const match = /if \(DESKTOP_APP_SPECIAL_TARGET\)(\s*)add_executable\(Packer\)/.exec(source);
  if (!match) throw new PatchError("Could not find the upstream Packer target.");
  return {
    search: match[0],
    replacement:
      "if (DESKTOP_APP_SPECIAL_TARGET OR CROSSGRAM_BUILD_UPDATE_PACKER)" +
      match[1] +
      "add_executable(Packer)",
    marker: "CROSSGRAM_BUILD_UPDATE_PACKER",
  };
}

/**
 * Where the upstream packer includes its signing keys. Telegram Desktop keeps
 * them in a sibling DesktopPrivate directory, the forks keep them next to the
 * packer itself.
 */
export function packerKeyHeaderRelative(source: string): string | null {
  if (source.includes('"../../../../DesktopPrivate/packer_private.h"')) {
    return "../../../../DesktopPrivate/packer_private.h";
  }
  if (source.includes('"packer_private.h"')) return "packer_private.h";
  return null;
}

/**
 * The private key header of the upstream packer. Every fork references
 * PrivateKey, most of them PrivateBetaKey, and the forks that do not include
 * Telegram Desktop's separate alpha_private.h read AlphaPrivateKey from here.
 */
export function keyHeader(privateKey: string, withAlphaKey: boolean): string {
  const lines = [
    "// Generated by the Crossgram updater feature; never committed.",
    'const char *PrivateKey = "' + cppKeyLiteral(privateKey) + '";',
    "const char *PrivateBetaKey = PrivateKey;",
  ];
  if (withAlphaKey) lines.push('static const char *AlphaPrivateKey = "";');
  return lines.join("\n") + "\n";
}

export function alphaKeyHeader(): string {
  return [
    "// Generated by the Crossgram updater feature; never committed.",
    'static const char *AlphaPrivateKey = "";',
    "",
  ].join("\n");
}

async function installPackerKeys(
  options: UpdaterPatchOptions,
  packerSource: string,
): Promise<void> {
  const privateKey = options.privateKey;
  if (!privateKey) return;
  const relative = packerKeyHeaderRelative(packerSource);
  if (!relative) throw new PatchError("Could not locate the packer private key include.");
  const target = join(options.root, "Telegram/SourceFiles/_other", relative);
  await mkdir(dirname(target), { recursive: true });
  // Telegram Desktop and its x64 fork keep the alpha key in a separate header.
  const separateAlphaHeader = packerSource.includes('"../../../../DesktopPrivate/alpha_private.h"');
  await writeFile(target, keyHeader(privateKey, !separateAlphaHeader), "utf8");
  if (separateAlphaHeader) {
    await writeFile(join(dirname(target), "alpha_private.h"), alphaKeyHeader(), "utf8");
  }
}

/** The upstream forks spell the prefix reader in a few different ways. */
export const PREFIX_SIGNATURES = [
  "const QString &readAutoupdatePrefixRaw()",
  "const QString& readAutoupdatePrefixRaw()",
  "QString readAutoupdatePrefixRaw()",
] as const;

export function prefixSignature(source: string): string {
  const found = PREFIX_SIGNATURES.filter((signature) => source.includes(signature + " {"));
  if (found.length === 0) {
    throw new PatchError("Could not find readAutoupdatePrefixRaw in the local storage.");
  }
  return found[0] as string;
}

/** Keep the fork's own return type so the injected body still compiles. */
export function prefixFunction(prefix: string, signature: string = PREFIX_SIGNATURES[0]): string {
  return [
    signature + " {",
    "\tExpects(!Core::UpdaterDisabled());",
    "",
    "\t// Crossgram builds follow the Crossgram release feed of their own",
    "\t// target, brand and platform instead of the upstream feed.",
    '\treturn AutoupdatePrefix("' + prefix + '");',
    "}",
  ].join("\n");
}

export async function patchUpdater(options: UpdaterPatchOptions): Promise<void> {
  const context = new PatchContext(options.root, options.target, options.featureRoot);
  const pem = options.publicKey ?? await readFile(join(options.featureRoot, "assets", "update-public-key.pem"), "utf8");
  if (options.privateKey) validateUpdateKeyPair(options.privateKey, pem);
  const key = cppKeyLiteral(pem);
  const active = options.platform !== null && options.build !== null;

  await context.edit(PACKER_ROOT, (file) => {
    const source = file.text();
    for (const patch of packerKeyPatches(source, key)) {
      file.replace(patch.search, patch.replacement, patch.marker);
    }
  });
  await context.edit(CMAKE_ROOT, (file) => {
    const source = file.text();
    if (source.includes("CROSSGRAM_BUILD_UPDATE_PACKER")) return;
    const patch = packerTargetPatch(source);
    file.replace(patch.search, patch.replacement, patch.marker);
  });
  await installPackerKeys(options, await readFile(join(options.root, PACKER_ROOT), "utf8"));

  if (!active) return;

  const version = crossgramVersion(options.build as number);
  const prefix = updatePrefix(options.target.id, options.brand, options.platform as UpdatePlatform);
  await context.edit(VERSION_ROOT, (file) => {
    const patch = versionPatch(file.text(), version);
    file.replace(patch.search, patch.replacement, patch.marker);
  });
  await context.edit(CONFIG_ROOT, (file) => {
    for (const patch of updateKeyPatches(file.text(), key)) {
      file.replace(patch.search, patch.replacement, patch.marker);
    }
  });
  await context.edit(LOCALSTORAGE_ROOT, (file) => {
    const signature = prefixSignature(file.text());
    file.replaceFunction(
      signature,
      prefixFunction(prefix, signature),
      'return AutoupdatePrefix("' + prefix + '");',
    );
  });
}
