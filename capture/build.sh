#!/bin/bash
# Build + sign ilcapture.
#
# The Info.plist is linked into the binary's __TEXT,__info_plist section rather
# than living in an .app bundle — that is what lets a plain CLI executable carry
# the TCC usage-description keys and a stable bundle identifier.
set -euo pipefail
cd "$(dirname "$0")"

IDENTITY="${CODESIGN_IDENTITY:-Developer ID Application: Andrei Alikimovich (ZMVK3ALPSD)}"
OUT="${1:-./ilcapture}"

swiftc -O -swift-version 5 \
	-target arm64-apple-macos26.0 \
	-framework CoreAudio -framework AudioToolbox -framework AVFoundation -framework Speech \
	-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
	-o "$OUT" \
	Sources/*.swift

codesign --force --options runtime --entitlements entitlements.plist \
	--sign "$IDENTITY" "$OUT"

echo "built $OUT"
codesign -dv --verbose=2 "$OUT" 2>&1 | grep -E "Identifier|Authority=Developer"
