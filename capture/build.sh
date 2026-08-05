#!/bin/bash
# Build + sign the capture helper as a minimal headless app bundle.
#
# The bundle exists for exactly one reason: TCC. For a bare CLI binary, macOS
# attributes the Screen & System Audio Recording grant to the "responsible
# process" — usually the terminal that launched it — and on some machines it
# never registers the attempt or shows the prompt at all (observed in the
# wild; see SPIKE.md). An executable inside an .app bundle gets its own
# first-class TCC identity, so the prompt appears reliably and reads
# "Transcriber Capture" no matter what launched it.
#
# The binary still embeds Info.plist in its __TEXT,__info_plist section, so a
# copy taken out of the bundle (the release zip ships one for pre-bundle
# installs) remains a self-describing, permission-capable executable.
set -euo pipefail
cd "$(dirname "$0")"

# TCC keys permission grants to the code signature. A Developer ID keeps them
# across rebuilds; ad-hoc signing works but macOS re-prompts every time the
# binary changes.
if [ -z "${CODESIGN_IDENTITY:-}" ]; then
	CODESIGN_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null |
		sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)
	: "${CODESIGN_IDENTITY:=-}"
fi
IDENTITY="$CODESIGN_IDENTITY"
APP="./TranscriberCapture.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"

swiftc -O -swift-version 5 \
	-target arm64-apple-macos26.0 \
	-framework CoreAudio -framework AudioToolbox -framework AVFoundation -framework Speech \
	-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
	-o "$APP/Contents/MacOS/tcapture" \
	Sources/*.swift

codesign --force --options runtime --entitlements entitlements.plist \
	--sign "$IDENTITY" "$APP" 2>/dev/null

# Convenience path for humans and scripts; the real thing lives in the bundle.
ln -sfn "TranscriberCapture.app/Contents/MacOS/tcapture" ./tcapture

echo "built $APP"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Identifier|Authority=Developer"
