#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { patchBranding } from "../features/branding/patch.js";
import { patchE2e } from "../features/e2e/patch.js";
import { patchServerSwitch } from "../features/server-switch/patch.js";
import { patchDirectDownload } from "../features/direct-download/patch.js";
import { patchFastUpload } from "../features/fast-upload/patch.js";
import { patchCrossInstanceForward } from "../features/cross-instance-forward/patch.js";
import { patchRawAnimation } from "../features/raw-animation/patch.js";
import { patchMergedForward } from "../features/merged-forward/patch.js";
import { patchPoke } from "../features/poke/patch.js";
import { patchAccessibility } from "../features/accessibility/patch.js";
import { patchCjkSegmentation } from "../features/cjk-segmentation/patch.js";
import { patchUpstreamCompatibility } from "../features/upstream-compat/patch.js";
import { patchRecalled } from "../features/recalled/patch.js";
import { patchWinUnicodeInput } from "../features/win-unicode-input/patch.js";
import { patchUpdater, type UpdatePlatform } from "../features/updater/patch.js";
import { brandById, resolveBrand } from "./brands.js";
import { resolveFeatures } from "./features.js";
import { targetById } from "./targets.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", short: "r" },
    target: { type: "string", short: "t" },
    brand: { type: "string", short: "b", default: "runtime" },
    feature: { type: "string", multiple: true, default: [] },
    "github-output": { type: "boolean", default: false },
    platform: { type: "string" },
    build: { type: "string" },
    "update-key-file": { type: "string" },
    "update-public-key-file": { type: "string" },
  },
});

async function readPrivateKey(file: string | undefined): Promise<string | null> {
  const path = file ?? process.env.CROSSGRAM_UPDATE_PRIVATE_KEY_FILE;
  if (!path) return null;
  return await readFile(path, "utf8");
}

const command = positionals[0];
if (!values.target || (command === "patch" && !values.root) || !["patch", "metadata"].includes(command ?? "")) {
  console.error("Usage: yarn apply --target <id> --brand <id|runtime> --root <tdesktop checkout> [--feature e2e] [--platform windows|linux|macos --build <run-number>]");
  console.error("       yarn metadata --target <id> --brand <id>");
  process.exitCode = 2;
} else {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const target = targetById(values.target);
  const requestedBrand = values.brand ?? "runtime";
  // `runtime` builds keep one binary and expose all themed brands in-app.
  const brand = requestedBrand === "runtime"
    ? null
    : resolveBrand(target, brandById(requestedBrand));
  const identity = brand ?? resolveBrand(target, brandById("cross"));
  const features = resolveFeatures(values.feature ?? []);
  if (command === "metadata") {
    const metadata = {
      target: target.id,
      repository: target.repository,
      upstreamExecutable: target.executable,
      executable: identity.executable,
      displayName: identity.title,
      packageSuffix: identity.packageSuffix,
      linuxId: identity.linuxId,
      windowsAppId: identity.windowsAppId,
      apiId: target.apiId,
      apiHash: target.apiHash,
      brand: brand?.id ?? "runtime",
    };
    if (values["github-output"]) {
      const output = process.env.GITHUB_OUTPUT;
      if (!output) throw new Error("GITHUB_OUTPUT is not set.");
      await appendFile(
        output,
        Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join(""),
        "utf8",
      );
    } else {
      console.log(JSON.stringify(metadata));
    }
  } else {
    await patchUpstreamCompatibility({
      root: values.root!,
      target,
    });
    await patchRecalled({
      root: values.root!,
      target,
      featureRoot: resolve(repositoryRoot, "features/recalled"),
    });
    await patchServerSwitch({
      root: values.root!,
      target,
      featureRoot: resolve(repositoryRoot, "features/server-switch"),
    });
    await patchDirectDownload({
      root: values.root!,
      target,
      featureRoot: resolve(repositoryRoot, "features/direct-download"),
    });
    await patchFastUpload({
      root: values.root!,
      target,
      featureRoot: resolve(repositoryRoot, "features/fast-upload"),
    });
    await patchCrossInstanceForward({
      root: values.root!,
      target,
      featureRoot: resolve(repositoryRoot, "features/cross-instance-forward"),
    });
    await patchRawAnimation({
      root: values.root!,
      target,
      featureRoot: resolve(repositoryRoot, "features/raw-animation"),
    });
    await patchPoke({
      root: values.root!,
      target,
      featureRoot: resolve(repositoryRoot, "features/poke"),
    });
    await patchMergedForward({
      root: values.root!,
      target,
      featureRoot: resolve(repositoryRoot, "features/merged-forward"),
    });
    await patchAccessibility({
      root: values.root!,
      target,
    });
    await patchCjkSegmentation({
      root: values.root!,
      target,
      featureRoot: resolve(repositoryRoot, "features/cjk-segmentation"),
    });
    await patchWinUnicodeInput({
      root: values.root!,
      target,
      featureRoot: resolve(repositoryRoot, "features/win-unicode-input"),
    });
    await patchBranding({
      root: values.root!,
      target,
      brand,
      featureRoot: resolve(repositoryRoot, "features/branding"),
    });
    await patchUpdater({
      root: values.root!,
      target,
      brand: brand?.id ?? "runtime",
      platform: (values.platform as UpdatePlatform | undefined) ?? null,
      build: values.build ? Number(values.build) : null,
      featureRoot: resolve(repositoryRoot, "features/updater"),
      privateKey: await readPrivateKey(values["update-key-file"]),
      publicKey: values["update-public-key-file"]
        ? await readFile(values["update-public-key-file"], "utf8")
        : null,
    });
    if (features.has("e2e")) {
      await patchE2e({
        root: values.root!,
        target,
        featureRoot: resolve(repositoryRoot, "features/e2e"),
      });
    }
    const enabled = features.size ? ` with ${[...features].join(", ")}` : "";
    console.log(`Patched ${values.target}/${brand?.id ?? "runtime"}${enabled} at ${resolve(values.root!)}.`);
  }
}
