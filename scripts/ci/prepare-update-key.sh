#!/usr/bin/env bash
# Source this file from the Linux workflow. Do not print any private key data.
UPDATE_KEY_FILE="$RUNNER_TEMP/crossgram-update-key.pem"
UPDATE_PUBLIC_KEY_FILE=""
umask 077

if [[ "${BUILD_ONLY:-false}" == "true" ]]; then
  # The upstream Packer requires a 128-byte RSA signature, not RSA-2048's 256 bytes.
  # Manual, unpublished builds must not use the production signing secret.
  openssl genrsa -traditional -out "$UPDATE_KEY_FILE" 1024 >/dev/null 2>&1
  UPDATE_PUBLIC_KEY_FILE="$RUNNER_TEMP/crossgram-update-public-key.pem"
  openssl rsa -in "$UPDATE_KEY_FILE" -RSAPublicKey_out -out "$UPDATE_PUBLIC_KEY_FILE" 2>/dev/null
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "Build-only: signed with a disposable RSA-1024 key pair. This build does not trust production updates." >> "$GITHUB_STEP_SUMMARY"
  fi
else
  if [[ -z "${UPDATE_KEY:-}" ]]; then
    echo "CROSSGRAM_UPDATE_KEY is required for published updates." >&2
    return 1
  fi
  printf '%s\n' "$UPDATE_KEY" > "$UPDATE_KEY_FILE"
fi
chmod 600 "$UPDATE_KEY_FILE"

if ! openssl rsa -in "$UPDATE_KEY_FILE" -check -noout >/dev/null 2>&1; then
  echo "Invalid CROSSGRAM_UPDATE_KEY: expected an unencrypted RSA private key in PEM format." >&2
  return 1
fi
key_bits="$(openssl rsa -in "$UPDATE_KEY_FILE" -text -noout 2>/dev/null | sed -nE '1s/.*\\(([0-9]+) bit.*/\\1/p')"
if [[ "$key_bits" != "1024" ]]; then
  echo "Desktop update Packer requires RSA-1024 (128-byte signature); received RSA-${key_bits:-unknown}." >&2
  return 1
fi

if [[ -z "$UPDATE_PUBLIC_KEY_FILE" ]]; then
  trusted_key="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/features/updater/assets/update-public-key.pem"
  derived_der="$RUNNER_TEMP/crossgram-derived-public.der"
  trusted_der="$RUNNER_TEMP/crossgram-trusted-public.der"
  if ! openssl rsa -in "$UPDATE_KEY_FILE" -RSAPublicKey_out -outform DER -out "$derived_der" 2>/dev/null \
    || ! openssl rsa -RSAPublicKey_in -in "$trusted_key" -RSAPublicKey_out -outform DER -out "$trusted_der" 2>/dev/null \
    || ! cmp -s "$derived_der" "$trusted_der"; then
    echo "CROSSGRAM_UPDATE_KEY does not match features/updater/assets/update-public-key.pem. Restore the matching release private key, or rotate both keys deliberately." >&2
    rm -f "$derived_der" "$trusted_der"
    return 1
  fi
  rm -f "$derived_der" "$trusted_der"
fi
