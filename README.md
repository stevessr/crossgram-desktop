# Crossgram Desktop patcher

This repository applies opt-in features to Telegram Desktop forks without using Git patch files. `server-switch` adds a per-account MTProto server selector to the sign-in UI, while `branding` gives generated applications independent names and platform identifiers. The separately enabled `e2e` feature exposes the Qt accessibility tree to authenticated local test drivers.

For `bridge-media:` files, patched clients first call Crossgram's
`crossgram.getFileUrl` RPC and start one normal HTTP transfer for the whole file.
The existing part assembler reads from that shared transfer instead of issuing
one HTTP request per `upload.getFile` part. Any RPC, expiry, or HTTP failure silently falls back to the original `upload.getFile`
relay path. The download task exposes `crossgramDownloadTransport()` for
diagnostics and logs `crossgram_download_transport=<direct|relay>`.
While a document is downloading, its message status row also shows the selected
transport as a green **直连**, orange **中转**, or gray **连接中** badge.

Before uploading a prepared photo or regular document, patched clients hash the
local bytes once off the UI thread and call `crossgram.prepareMediaUpload` with
MD5, SHA-1, and the first-10-MiB MD5. A QQ rapid-upload hit skips every
`upload.saveFilePart` request while preserving Telegram's normal `InputFile`
send flow. RPC failures and cache misses fall back to the unchanged uploader;
voice, round-video, and secure uploads are never probed.

When Telegram already has a partial file, the one shared transfer starts with a
single open-ended `Range: bytes=<first-missing-offset>-` request. Fresh downloads
use a normal GET; neither path creates one HTTP request per 128 KiB part.

The same direct HTTP path is used for `bridge-sticker:` and
`bridge-reaction-resource:` documents. Original PNG, GIF, and APNG assets are
kept in their source format: animated image documents use the upstream
FFmpeg streaming pipeline, while animated stickers and custom reactions reuse
the alpha-preserving sticker clip player. No desktop-specific WebM/WebP
derivative is required from the relay.

Message drags use a Crossgram process-local token instead of Telegram
Desktop's bare `application/x-td-forward` marker. A drop inside the same
process and account keeps native forwarding. Drops into another process or
account fall back to the standard image or local-file MIME payload and are
uploaded as new media, which also allows downloaded media to be dragged into
an unmodified Telegram Desktop instance. A foreign Telegram Desktop drag is
treated the same way when it exposes loaded image data or downloaded files.
Multi-message drags export every loaded photo and every downloaded or
memory-cached document into an ordered local-file list; if any selected item
cannot be materialized, the external file payload is suppressed rather than
sending only part of the selection.

QQ pokes ("戳一戳") are not a Telegram action, so patched clients put one on the menus
Telegram Desktop already builds around an avatar: clicking a message author's avatar in a
group sends a single poke, and hovering the arrow sends 1, 5, or 10 at once. The entry only
exists when the relay answers `crossgram.getFeatures` for that conversation with poke
support, which keeps it out of official Telegram servers entirely; see
[`features/poke`](features/poke).

Telegram Desktop exposes every loaded message of a chat as an accessibility
row and rebuilds that row list, asking every message whether it is hidden, on
every read. A screen reader reads several properties per row and walks all
rows on a focus change, so one focus change in a long history used to cost
quadratic time on the UI thread and froze the client. Patched clients keep the
row list cached and drop it whenever messages, views, histories, or the
migrated history change; see [`features/accessibility`](features/accessibility)
for the invalidation points.

Windows reports text that a program injects with `KEYEVENTF_UNICODE` as a
`VK_PACKET` key press followed by a `WM_CHAR` carrying the character. Qt's
Windows key mapper consumes that `WM_CHAR` while handling the key press and
keeps one key record per virtual key, so an input tool that does not release a
packet before sending the next one, WeChat voice input for example, makes the
previous character repeat and the new one disappear. Patched clients drop the
`VK_PACKET` key press and key release before Qt's mapper sees them, and let Qt
deliver the queued character through its own character path, combining
surrogate pairs the way Qt does; see
[`features/win-unicode-input`](features/win-unicode-input).

Chinese and Japanese text runs its words together, while the separator list
of the client and Qt's own cursor movement know punctuation alone: a double
click on such a text selected a whole sentence, and Ctrl+Left/Right jumped
over one. Patched clients split a run of such characters with a frequency
dictionary, the same step that the mobile clients of the service get from
their platform, and treat the punctuation of those scripts the way the
separator list treats a space; see
[`features/cjk-segmentation`](features/cjk-segmentation).

A QQ merged forward reaches the clients as a synthetic basic chat that the
relay renders from the archived bundle. Patched clients keep that peer out of
the chat list: resolving its link marks the peer as a history-only view,
suppresses the peer-dialog request Telegram Desktop would use to materialize
it, and drops the chat-list entry the data session creates. The deep link
anchors at the first message of the transcript, so opening it lands on the
beginning of the bundle instead of its newest message. The client also asks the
relay for the beginning at open time (a history request anchored at the offset
id 1 sentinel, which synthetic hashed ids never take), so a card whose content
was cached before the relay changed the anchor still opens at the beginning;
the link anchor stays the fallback, and legacy `bridgechat_...` links keep
working the same way. See
[`features/merged-forward`](features/merged-forward).

Supported upstreams:

- `telegramdesktop/tdesktop`
- `TDesktop-x64/tdesktop`
- `AyuGram/AyuGramDesktop`
- `kukuruzka165/materialgram`

`kotatogram/kotatogram-desktop` is deferred because its latest release is based on a substantially older tdesktop architecture. Supporting it would require maintaining a separate integration path for account startup, UI widgets and layout, and MTProto configuration loading.

Crossgram desktop builds update themselves from the Crossgram release feed. Each
build carries `AppVersion = 100000000 + <workflow run>` and asks
`raw.githubusercontent.com/crossgram-project/crossgram-desktop/updates/<target>-<brand>/<platform>/current6`
where the release pipeline publishes `<version>:<update payload url>`. The payload
is a normal tdesktop update file signed with the Crossgram update key
(`CROSSGRAM_UPDATE_KEY`), which the compiled-in public key in `config.h` verifies
before the staged update replaces the binary on the next start; see
[`features/updater`](features/updater).
## Apply the feature

Node.js 22 or newer and Yarn 4 are required.

```bash
corepack enable
yarn install --immutable
yarn apply --target tdesktop --brand runtime --root /path/to/tdesktop
```

To produce one universal package instead of one package per themed brand, use
`--brand runtime`. The resulting binary exposes **Crossgram brand** in the
main menu; selecting a brand persists it under `tdata/crossgram-brand` and
restarts the client so the new display name is applied.

Normal builds do not contain the semantic automation endpoint. Add
`--feature e2e` only for a controlled E2E build; see
[`features/e2e/README.md`](features/e2e/README.md) for the runtime protocol and
driver examples.

Target ids are `tdesktop`, `tdesktop-x64`, `ayugram`, and `materialgram`. Brand ids are `cross`, `qq`, `wechat`, `wecom`, `dingtalk`, and `discord`; `runtime` is the default. Legacy per-brand builds remain available only when explicitly requested. `runtime` is a universal build mode that allows switching among all six brands in-app. Applying the patch repeatedly is supported and produces byte-identical output.

The patcher performs unique, structural edits around C++ function bodies, declarations, includes, CMake metadata, and desktop integration files. A missing or ambiguous anchor is a hard failure. Large injected implementations and their integration logic are isolated under [`features/server-switch`](features/server-switch), [`features/branding`](features/branding), and [`features/e2e`](features/e2e).

## Build branding

Universal builds use a stable Cross platform identity and executable name; the menu changes only the display brand. Default builds use `CrossTelegram`, `Cross64Gram`, `CrossAyuGram`, or `CrossMaterialgram` and append `.crossgram` to the upstream platform identifier. Every supported upstream also ships these themed brands:

- `QQ · Cross` / `.crossgram.qq`
- `微信 · Cross` / `.crossgram.wechat`
- `企业微信 · Cross` / `.crossgram.wecom`
- `钉钉 · Cross` / `.crossgram.dingtalk`
- `Discord · Cross` / `.crossgram.discord`

Windows receives a distinct deterministic AppId, macOS a distinct bundle id, and Linux a distinct desktop/application id. Display names may contain Unicode; executable filenames remain ASCII. The themed icons are current App Store CDN artwork with source URLs and SHA-256 hashes recorded in [`features/branding/assets/SOURCES.md`](features/branding/assets/SOURCES.md).

These are unofficial themed builds and are not affiliated with or endorsed by Tencent, Alibaba, Discord, Telegram, or the upstream client projects.

## User experience

The sign-in screen contains a **Server** button. Its popup contains:

- **Official Telegram**, which removes the account's custom configuration;
- the account's saved custom configuration, when present;
- **Add custom configuration...**, which opens a multiline JSON input with Confirm, Read from clipboard, and Cancel buttons.

The input schema is:

```json
{
  "name": "My custom server",
  "enable_special_config": false,
  "host": "192.168.1.100",
  "port": 4430,
  "rsa_key": "-----BEGIN RSA PUBLIC KEY-----\n...\n-----END RSA PUBLIC KEY-----",
  "dcs": [
    { "id": 1, "ip": "192.168.1.100", "port": 4430 },
    { "id": 2, "ip": "192.168.1.100", "port": 4430 },
    { "id": 3, "ip": "192.168.1.100", "port": 4430 },
    { "id": 4, "ip": "192.168.1.100", "port": 4430 },
    { "id": 5, "ip": "192.168.1.100", "port": 4430 }
  ]
}
```

The client rejects malformed JSON, invalid IP addresses or ports, duplicate DC ids, and invalid RSA public keys. Switching is allowed only before an account signs in. It rebuilds that account's MTProto instance without carrying authorization keys across servers.

Each account stores its JSON at:

```text
tdata/<account-hash>/server-switch.json
```

`QSaveFile` provides atomic writes. The file contains connection metadata and a public key, not account credentials.

## WSS MTProto through Cloudflare

Custom accounts can select `transport: "websocket"` with a strict `wss://`
DNS URL. Legacy TCP JSON and official accounts remain supported. See
[configuration, isolation, server/Cloudflare setup and verification](features/server-switch/WSS.md).
Do not use the management `/api` WebSocket as an MTProto endpoint.

## CI and releases

[`check.yml`](.github/workflows/check.yml) resolves and patches all 28 target/build-mode combinations (including runtime mode for every target) in parallel. Matrix fail-fast is disabled, so a broken upstream or brand does not cancel the others.

[`release.yml`](.github/workflows/release.yml) resolves all upstream versions once and
generates a dynamic matrix. Scheduled and manual runs use the single `runtime` universal brand by
default, while manual dispatches can request legacy per-brand batches with the
`brands` input. Both modes inspect release assets produced from the current patcher
commit and only rebuild missing package/symbol pairs.

Each run publishes every successful target, brand, and platform into one unified
`Crossgram Desktop #<run-number>` release, matching the Android release model. One
job's failure does not prevent the other successful builds from being published.

User archives contain stripped production binaries built with `NDEBUG` and `QT_NO_DEBUG`. Debug information is kept out of those archives and published as separate `*.symbols.*` assets: PDB files on Windows, split debug files on Linux, and dSYM bundles on macOS.

The publish job uses `GITHUB_TOKEN` with repository Contents write permission.

CI uses the Crossgram project's Telegram API identity for every supported client target. Repository secrets `TDESKTOP_API_ID` and `TDESKTOP_API_HASH` may override both values together; a partial override is rejected. Release builds never fall back to `TDESKTOP_API_TEST=ON`.

The workflows cache Yarn artifacts, Linux Python package downloads and BuildKit
dependency-image layers, plus the Windows/macOS `TBuild/Libraries` and
`TBuild/ThirdParty` dependency trees. Native cache keys include the target and the
upstream prepare-script hash, while BuildKit validates its own layer inputs, so
regular app releases can reuse prepared Qt and third-party libraries without
accepting another target's or a stale build recipe's dependencies.

Release tags use this form:

```text
crossgram-<workflow-run-number>
```

## Development checks

```bash
yarn check
yarn build
```

The test suite covers structural function matching, CRLF preservation, ambiguous-anchor rejection, and the supported-target registry. Runtime tests require `ffmpeg`, `ffprobe`, and a C++20 compiler (`clang++` by default; override its executable with `CXX`). The accessibility regression compiles and executes the generated cache code instead of relying only on text assertions. The CJK segmentation regression compiles and executes the generated dictionary and word boundaries the same way.

### Manual Linux build (without publishing)

Open **Actions → Manual Linux desktop build → Run workflow**. Select an upstream
(default: `tdesktop-x64` / 64Gram) and `runtime` for the universal package. This
reuses the native desktop build and smoke-test pipeline, uploads packages/symbols
as Actions artifacts, and never runs the release publication job. Manual builds
always rebuild the requested target. Linux build-only runs always generate a disposable RSA-1024 signing pair and
embed its matching public key, even when the production secret exists.
These artifacts do not trust production automatic updates. No private key is
uploaded. Published builds require a 1024-bit `CROSSGRAM_UPDATE_KEY` matching
`features/updater/assets/update-public-key.pem`; the key is checked before compilation. Existing scheduled releases still require the configured signing key.
A successful WSS native test is not a successful complete desktop build; inspect
the desktop build job and uploaded artifacts separately. Upstream patch-anchor
failures can still block individual targets (currently tdesktop and AyuGram).
