#!/bin/bash
# Transcriber installer.
#
# Checks prerequisites, asks for everything it needs in one block, then builds
# and configures without further interruption. Safe to re-run: anything already
# in place is detected and skipped.
set -euo pipefail

cd "$(dirname "$0")"
REPO="$(pwd)"

bold=$(tput bold 2>/dev/null || true)
dim=$(tput dim 2>/dev/null || true)
red=$(tput setaf 1 2>/dev/null || true)
green=$(tput setaf 2 2>/dev/null || true)
yellow=$(tput setaf 3 2>/dev/null || true)
reset=$(tput sgr0 2>/dev/null || true)

say() { printf '%s\n' "$*"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$*"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset" "$*"; }
die() {
	printf '  %s✗%s %s\n' "$red" "$reset" "$1" >&2
	[ $# -gt 1 ] && printf '\n    %s\n' "$2" >&2
	exit 1
}

interactive=1
[ -t 0 ] || interactive=0

say ""
say "${bold}Transcriber${reset}"
say "${dim}records and transcribes conversations, on-device${reset}"
say ""

# ---------------------------------------------------------------------------
# 1. Preflight — no questions, fail fast with a fix
# ---------------------------------------------------------------------------

say "${bold}Checking prerequisites${reset}"

[ "$(uname -s)" = "Darwin" ] || die "this only runs on macOS"

arch=$(uname -m)
[ "$arch" = "arm64" ] || die "Apple Silicon required (found $arch)"

macos_major=$(sw_vers -productVersion | cut -d. -f1)
if [ "$macos_major" -lt 26 ]; then
	die "macOS 26 or newer required (found $(sw_vers -productVersion))" \
		"On-device transcription uses SpeechAnalyzer, which is macOS 26+."
fi
ok "macOS $(sw_vers -productVersion) on $arch"

# Command Line Tools are sufficient — the build uses swiftc directly and never
# needs a full Xcode install.
if ! command -v swiftc >/dev/null 2>&1; then
	die "Swift compiler not found" \
		"Install the Command Line Tools (~1GB, no Xcode needed):  xcode-select --install"
fi
ok "Swift $(swift --version 2>/dev/null | sed -n 's/.*Swift version \([0-9.]*\).*/\1/p' | head -1)"

# ---------------------------------------------------------------------------
# 2. Work out what is missing
# ---------------------------------------------------------------------------

need_bun=0
command -v bun >/dev/null 2>&1 || need_bun=1
if [ "$need_bun" -eq 0 ]; then ok "bun $(bun --version)"; else warn "bun not installed"; fi

# TCC keys grants to the code signature. A Developer ID keeps them across
# rebuilds; ad-hoc signing works but macOS re-prompts every time the binary
# changes.
identities=$(security find-identity -v -p codesigning 2>/dev/null |
	sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' || true)
identity_count=$(printf '%s' "$identities" | grep -c . || true)
SIGN_IDENTITY=""
if [ "$identity_count" -eq 1 ]; then
	SIGN_IDENTITY="$identities"
	ok "signing identity: $SIGN_IDENTITY"
elif [ "$identity_count" -eq 0 ]; then
	warn "no Developer ID certificate — will sign ad-hoc"
fi

default_bindir="$HOME/.local/bin"
say ""

# ---------------------------------------------------------------------------
# 3. Everything we need to ask, asked once
# ---------------------------------------------------------------------------

CHOSEN_BINDIR=""
CHOSEN_STORE="${TRANSCRIBER_CONVERSATIONS:-$HOME/Documents/Conversations}"
DO_MIC=0
DO_SKILL=1

if [ "$interactive" -eq 1 ]; then
	say "${bold}A few questions, then it runs unattended${reset}"
	say ""

	if [ "$identity_count" -gt 1 ]; then
		say "  ${dim}Multiple Developer ID certificates found. Permission grants are tied"
		say "  to whichever one signs the helper.${reset}"
		i=1
		while IFS= read -r line; do
			say "    $i) $line"
			i=$((i + 1))
		done <<<"$identities"
		printf '  Which one? [1] '
		read -r choice || true
		choice=${choice:-1}
		SIGN_IDENTITY=$(printf '%s' "$identities" | sed -n "${choice}p")
		say ""
	fi

	printf '  Install the %stranscriber%s command into %s? [Y/n] ' "$bold" "$reset" "$default_bindir"
	read -r reply || true
	case "${reply:-y}" in [Nn]*) CHOSEN_BINDIR="" ;; *) CHOSEN_BINDIR="$default_bindir" ;; esac

	say ""
	printf '  Where should recordings be stored? [%s] ' "$CHOSEN_STORE"
	read -r reply || true
	[ -n "$reply" ] && CHOSEN_STORE="${reply/#~/$HOME}"

	say ""
	printf '  Grant microphone access now? (needed to record your side) [Y/n] '
	read -r reply || true
	case "${reply:-y}" in [Nn]*) DO_MIC=0 ;; *) DO_MIC=1 ;; esac

	say ""
	printf '  Install the %s/transcriber%s skill for Claude Code? [Y/n] ' "$bold" "$reset"
	read -r reply || true
	case "${reply:-y}" in [Nn]*) DO_SKILL=0 ;; *) DO_SKILL=1 ;; esac
	say ""
else
	CHOSEN_BINDIR="$default_bindir"
	DO_SKILL=1
	say "${dim}non-interactive: using defaults${reset}"
fi

# ---------------------------------------------------------------------------
# 4. Do the work
# ---------------------------------------------------------------------------

say "${bold}Installing${reset}"

if [ "$need_bun" -eq 1 ]; then
	say "  installing bun…"
	curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 ||
		die "bun install failed" "Install it manually: https://bun.sh"
	export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
	export PATH="$BUN_INSTALL/bin:$PATH"
	command -v bun >/dev/null 2>&1 || die "bun installed but not on PATH" \
		"Add \$HOME/.bun/bin to your PATH and re-run."
	ok "bun $(bun --version)"
fi

say "  building the capture helper…"
if [ -n "$SIGN_IDENTITY" ]; then
	CODESIGN_IDENTITY="$SIGN_IDENTITY" ./capture/build.sh >/dev/null
	ok "built and signed with your Developer ID"
else
	CODESIGN_IDENTITY="-" ./capture/build.sh >/dev/null
	ok "built and signed ad-hoc"
	warn "macOS will re-ask for permissions after every rebuild (no Developer ID)"
fi

say "  installing dependencies…"
(cd cli && bun install --silent >/dev/null 2>&1) || die "bun install failed"
ok "dependencies installed"

if [ -n "$CHOSEN_BINDIR" ]; then
	mkdir -p "$CHOSEN_BINDIR"
	launcher="$CHOSEN_BINDIR/transcriber"
	bun_path="$(command -v bun)"
	cat >"$launcher" <<EOF
#!/bin/bash
# Generated by install.sh — regenerate by re-running it.
# An already-set TRANSCRIBER_CONVERSATIONS wins over the installed default.
export TRANSCRIBER_CONVERSATIONS="\${TRANSCRIBER_CONVERSATIONS:-$CHOSEN_STORE}"
exec "$bun_path" run "$REPO/cli/src/cli.tsx" "\$@"
EOF
	chmod +x "$launcher"
	ok "installed $launcher"
	case ":$PATH:" in
	*":$CHOSEN_BINDIR:"*) ;;
	*) warn "$CHOSEN_BINDIR is not on your PATH — add it to your shell profile" ;;
	esac
fi

if [ "$DO_SKILL" -eq 1 ]; then
	skill_dir="$HOME/.claude/skills"
	mkdir -p "$skill_dir"
	# Symlinked, not copied, so editing the repo updates the skill.
	ln -sfn "$REPO/skill" "$skill_dir/transcriber"
	ok "installed the /transcriber skill"
fi

if [ "$DO_MIC" -eq 1 ]; then
	say "  requesting microphone access…"
	./capture/tcapture request-mic || warn "microphone not granted (you can re-run: ./capture/tcapture request-mic)"
fi

# ---------------------------------------------------------------------------
# 5. Verify, and trigger the system-audio prompt while the user is still here
# ---------------------------------------------------------------------------

say ""
say "${bold}Checking the install${reset}"
say "${dim}  macOS will ask for Screen & System Audio Recording — say yes.${reset}"
say ""
(cd cli && bun run src/cli.tsx doctor) || true

say ""
say "${bold}Ready.${reset}"
say ""
say "  ${dim}See what is playing audio:${reset}  transcriber doctor"
say "  ${dim}Record a call:${reset}             transcriber record --match zoom"
say "  ${dim}Record everything:${reset}         transcriber record --all"
say ""
say "  ${dim}Recordings land in $CHOSEN_STORE. Headphones give the cleanest"
say "  channel separation; on the built-in speakers, echo cancellation keeps the"
say "  other side's voice off your mic channel.${reset}"
say ""
