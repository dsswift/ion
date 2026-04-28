#!/usr/bin/env bash
# ──────────────────────────────────────────────────────
#  ensure-dev-cert.sh — Create a stable code signing
#  certificate for local development builds.
#
#  macOS TCC (Transparency, Consent, and Control) tracks
#  permission grants by code signature identity. Ad-hoc
#  signatures change every build, so the user gets
#  re-prompted for file access on every rebuild. Using a
#  persistent self-signed cert keeps the identity stable.
#
#  This script is idempotent — it does nothing if the
#  certificate already exists.
# ──────────────────────────────────────────────────────
set -euo pipefail

CERT_NAME="Ion Local Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# Only run on macOS
[[ "$(uname)" == "Darwin" ]] || exit 0

# Check if the certificate already exists as a valid codesigning identity
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$CERT_NAME"; then
  echo "  ✓ Code signing certificate '$CERT_NAME' found"
  exit 0
fi

echo "  Creating code signing certificate '$CERT_NAME'..."

# Create a temporary working directory
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# Generate OpenSSL config with Code Signing EKU
# The extendedKeyUsage = codeSigning is critical — without it,
# `security find-identity -p codesigning` won't list the cert
cat > "$WORK_DIR/cert.conf" <<EOF
[req]
distinguished_name = req_dn
x509_extensions = codesign
prompt = no

[req_dn]
CN = $CERT_NAME

[codesign]
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
basicConstraints = critical, CA:false
EOF

# Generate the self-signed certificate (10-year validity)
openssl req -x509 -newkey rsa:2048 \
  -config "$WORK_DIR/cert.conf" \
  -keyout "$WORK_DIR/dev.key" \
  -out "$WORK_DIR/dev.crt" \
  -days 3650 -nodes 2>/dev/null

# Package as PKCS#12 for import into Keychain.
# OpenSSL 3.x defaults to algorithms macOS Keychain doesn't understand,
# so we force legacy PBE ciphers and SHA-1 MAC for compatibility.
# A non-empty password is required — empty passwords cause MAC verification
# failures on import.
P12_PASS="ion-local-dev"
openssl pkcs12 -export \
  -out "$WORK_DIR/dev.p12" \
  -inkey "$WORK_DIR/dev.key" \
  -in "$WORK_DIR/dev.crt" \
  -passout "pass:$P12_PASS" \
  -certpbe PBE-SHA1-3DES \
  -keypbe PBE-SHA1-3DES \
  -macalg sha1 2>/dev/null

# Import into the login keychain with codesign ACL
security import "$WORK_DIR/dev.p12" \
  -k "$KEYCHAIN" \
  -T /usr/bin/codesign \
  -P "$P12_PASS"

# Set the partition list so codesign can use the key without prompting.
# This requires the keychain to be unlocked (it is during interactive use).
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "" "$KEYCHAIN" 2>/dev/null || true

# Trust the self-signed cert for code signing.
# Without this, macOS considers it CSSMERR_TP_NOT_TRUSTED and codesign
# refuses to use it. This may trigger a macOS admin password prompt.
security add-trusted-cert -d -r trustRoot -p codeSign \
  -k "$KEYCHAIN" "$WORK_DIR/dev.crt"

# Verify the certificate was imported and trusted correctly
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$CERT_NAME"; then
  echo "  ✓ Code signing certificate '$CERT_NAME' created and trusted"
else
  echo "  ⚠ Certificate was created but may not appear in codesigning identities."
  echo "    You may need to manually trust it in Keychain Access:"
  echo "    1. Open Keychain Access"
  echo "    2. Find '$CERT_NAME' in the login keychain"
  echo "    3. Double-click it > Trust > Code Signing: Always Trust"
  exit 1
fi
