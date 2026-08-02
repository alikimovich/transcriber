#!/bin/bash
# Build, sign, notarize, and publish a GitHub release.
#
#   scripts/release.sh 0.1.0
#
# One-time setup (Apple credentials for notarization):
#
#   xcrun notarytool store-credentials transcriber-notary \
#     --apple-id <your-apple-id> --team-id ZMVK3ALPSD \
#     --password <app-specific password from appleid.apple.com>
#
# The zip itself is what gets notarized; flat binaries can't have a ticket
# stapled to them, so Gatekeeper verifies the notarization online on first
# run. That is the normal arrangement for CLI tools shipped outside a .pkg.
set -euo pipefail
cd "$(dirname "$0")/.."

bold=$(tput bold 2>/dev/null || true)
red=$(tput setaf 1 2>/dev/null || true)
reset=$(tput sgr0 2>/dev/null || true)
say() { printf '%s\n' "$*"; }
die() {
	printf '%s✗%s %s\n' "$red" "$reset" "$1" >&2
	[ $# -gt 1 ] && printf '\n  %s\n' "$2" >&2
	exit 1
}

VERSION="${1:?usage: scripts/release.sh <version>   (e.g. 0.1.0)}"
PROFILE="${NOTARY_PROFILE:-transcriber-notary}"
TAG="v$VERSION"

# ---------------------------------------------------------------------------
# Preflight — fail before building anything
# ---------------------------------------------------------------------------

pkg_version=$(bun -e 'console.log(JSON.parse(await Bun.file("cli/package.json").text()).version)')
[ "$pkg_version" = "$VERSION" ] ||
	die "cli/package.json says $pkg_version, not $VERSION" \
		"Bump the version there (and in capture/Info.plist) first, and commit."

plist_version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' capture/Info.plist)
[ "$plist_version" = "$VERSION" ] ||
	die "capture/Info.plist says $plist_version, not $VERSION" \
		"Keep it in lockstep with cli/package.json."

[ -z "$(git status --porcelain)" ] ||
	die "working tree is not clean" "Releases are built from committed code only."

git rev-parse "$TAG" >/dev/null 2>&1 && die "tag $TAG already exists"

# Distribution requires a real Developer ID — an ad-hoc signature can't be
# notarized and Gatekeeper would reject it on every other machine.
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null |
	sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)
[ -n "$IDENTITY" ] || die "no Developer ID Application certificate found"

xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 ||
	die "notarization credentials not found (keychain profile \"$PROFILE\")" \
		"Run the store-credentials command in this script's header once."

command -v gh >/dev/null 2>&1 || die "gh CLI not found"

# ---------------------------------------------------------------------------
# Build and sign
# ---------------------------------------------------------------------------

say "${bold}Building${reset}"
CODESIGN_IDENTITY="$IDENTITY" ./capture/build.sh
# Re-sign without get-task-allow: the dev entitlements keep it so lldb can
# attach, but notarization rejects any binary that requests it.
codesign --force --options runtime --entitlements capture/entitlements-release.plist \
	--sign "$IDENTITY" capture/tcapture

(cd cli && bun install --silent && bun run check && bun run build:bin)
codesign --force --options runtime --entitlements scripts/cli-entitlements.plist \
	--sign "$IDENTITY" cli/dist/transcriber

# ---------------------------------------------------------------------------
# Stage and notarize
# ---------------------------------------------------------------------------

STAGE="dist/transcriber-$TAG-macos-arm64"
ZIP="$STAGE.zip"
rm -rf dist && mkdir -p "$STAGE"
cp cli/dist/transcriber capture/tcapture LICENSE README.md "$STAGE/"
ditto -c -k --keepParent "$STAGE" "$ZIP"

say "${bold}Notarizing${reset} (takes a few minutes)"
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait |
	tee /dev/stderr | grep -q "status: Accepted" ||
	die "notarization was not accepted" \
		"xcrun notarytool log <submission-id> --keychain-profile $PROFILE"

# ---------------------------------------------------------------------------
# Tag and publish
# ---------------------------------------------------------------------------

say "${bold}Publishing${reset}"
git tag "$TAG"
git push origin "$TAG"
gh release create "$TAG" "$ZIP" \
	--title "Transcriber $VERSION" \
	--generate-notes

say ""
say "${bold}Released $TAG.${reset}"
