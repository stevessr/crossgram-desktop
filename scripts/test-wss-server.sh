#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
server="$(cd "${1:?Usage: test-wss-server.sh /path/to/crossgram}" && pwd)"
build="$(mktemp -d)"
fixture="$(mktemp "$server/packages/mtproto/src/transport/desktop-wss-XXXXXX.e2e.test.ts")"
trap 'rm -f "$fixture"; rm -rf "$build"' EXIT
"$root/scripts/test-wss-native.sh" "$build"
cp "$root/tests/native/wss/server-fixture.e2e.ts.fixture" "$fixture"
export WSS_FIXTURE_CERT="$build/cert.pem" WSS_FIXTURE_KEY="$build/key.pem"
export WSS_FIXTURE_BINARY="$build/wss-req-pq"
cd "$server"
"$server/node_modules/.bin/vitest" run --config vitest.mtproto-e2e.config.mts "$fixture" --maxWorkers=1
