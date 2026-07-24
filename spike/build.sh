#!/bin/bash
# Build + sign the capture spike.
#
# The Info.plist is linked into the binary's __TEXT,__info_plist section rather
# than living in a bundle — that is what lets a plain CLI executable carry the
# TCC usage-description keys and a stable bundle identifier.
set -euo pipefail
cd "$(dirname "$0")"

IDENTITY="${CODESIGN_IDENTITY:-Developer ID Application: Andrei Alikimovich (ZMVK3ALPSD)}"

swiftc -O -swift-version 5 \
	-target arm64-apple-macos26.0 \
	-framework CoreAudio -framework AudioToolbox -framework Foundation \
	-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
	-o ilprobe ilprobe.swift

# get-task-allow keeps `sample`/lldb usable; drop it for anything shipped.
codesign --force --options runtime --entitlements debug.entitlements \
	--sign "$IDENTITY" ilprobe

echo "built ./ilprobe"
codesign -dv --verbose=2 ilprobe 2>&1 | grep -E "Identifier|Authority=Developer"
