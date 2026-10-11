# Server switch feature

`patch.ts` integrates the feature into a Telegram Desktop checkout. The two `server_switch` files are copied into `Telegram/SourceFiles/crossgram/`; reusable method bodies are kept under `fragments/` so the patch logic stays readable.

Integration points:

- `Intro::Widget`: server button, popup, and editor box;
- `Storage::Account`: per-account JSON path;
- `Main::Account`: startup application and MTProto recreation on selection;
- `MTP::DcOptions`: custom endpoints, custom RSA key, immutable server updates, and special-config state;
- `ConfigLoader`: skips special config when disabled;
- `Telegram/CMakeLists.txt`: compiles the injected implementation.

Kotatogram is intentionally deferred: its current release needs a separate legacy integration path rather than the shared structural edits used by the supported targets.

For the WSS socket adapter, account binding, limits and deployment instructions,
see [WSS.md](WSS.md).
