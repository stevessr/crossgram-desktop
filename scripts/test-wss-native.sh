#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
build="${1:-$(mktemp -d)}"
mkdir -p "$build"
cmake -S "$root/tests/native/wss" -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build "$build"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$build/key.pem" \
  -out "$build/cert.pem" -days 1 -subj /CN=localhost.localdomain \
  -addext subjectAltName=DNS:localhost.localdomain 2>/dev/null
"$build/wss-stream" "$build/cert.pem" "$build/key.pem"
