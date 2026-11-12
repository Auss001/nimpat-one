#!/usr/bin/env bash
# One-time, on the owner's own computer: makes ONE Apple distribution certificate for Nimpat One, so iPhone builds
# stop asking Apple for a new certificate every time (Apple allows only a few, then builds fail with
# "maximum number of certificates").
#
# It runs here and not on GitHub on purpose: the GitHub repository is public, and files a workflow hands back
# (artifacts) can be downloaded by anyone signed in to GitHub. A signing certificate must never be put there.
#
#   bash app/ios/scripts/make-cert.sh <Key ID> <Issuer ID> <path to AuthKey_XXXX.p8>
#
# The three values are the same App Store Connect key the builds already use. The result goes to a folder on the
# Desktop (outside the project, so it can never be committed):
#   nimpat-one-distribution.p12   keep this somewhere safe
#   secrets.txt                   two values to add as GitHub repository secrets, then delete this file
# The certificate lasts one year. Run this again when it expires or if it is ever revoked.
set -euo pipefail
umask 077
if [ $# -ne 3 ] || [ ! -f "$3" ]; then
  echo "Use: bash app/ios/scripts/make-cert.sh <Key ID> <Issuer ID> <path to AuthKey_XXXX.p8>"
  exit 1
fi
# On Windows (Git Bash), node and openssl cannot read /c/... style paths, so turn them into C:/... form.
winpath() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf "%s" "$1"; fi; }
HERE="$(winpath "$(cd "$(dirname "$0")" && pwd)")"
OUT="$(winpath "$HOME/Desktop/nimpat-iphone-certificate")"
WORK="$(winpath "$(mktemp -d)")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"
export MSYS_NO_PATHCONV=1
openssl genrsa -out "$WORK/dist.key" 2048 2> /dev/null
openssl req -new -key "$WORK/dist.key" -subj "/CN=Nimpat One Distribution/C=NG" -out "$WORK/dist.csr"
ASC_KEY_ID="$1" ASC_ISSUER_ID="$2" ASC_KEY_PATH="$3" node "$HERE/asc.mjs" make-cert "$WORK/dist.csr" "$WORK/dist.cer"
openssl x509 -inform DER -in "$WORK/dist.cer" -out "$WORK/dist.pem"
PASS="$(openssl rand -hex 20)"
# The older 3DES packing is the one a Mac keychain reads.
openssl pkcs12 -export -inkey "$WORK/dist.key" -in "$WORK/dist.pem" -name "Nimpat One Distribution" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -passout "pass:$PASS" -out "$OUT/nimpat-one-distribution.p12"
{
  echo "Add these two as GitHub repository secrets (Settings > Secrets and variables > Actions), then delete this file."
  echo
  echo "IOS_DIST_CERT_P12_BASE64"
  base64 -w0 "$OUT/nimpat-one-distribution.p12"
  echo
  echo
  echo "IOS_DIST_CERT_PASSWORD"
  echo "$PASS"
} > "$OUT/secrets.txt"
echo "Done. Open the folder 'nimpat-iphone-certificate' on the Desktop and follow secrets.txt."
