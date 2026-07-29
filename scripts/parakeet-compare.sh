#!/bin/bash
# Transcribe a recorded session with Parakeet (NVIDIA parakeet-tdt via MLX) and
# write transcript-parakeet.md next to the on-device transcript.md, so the two
# engines can be compared on identical audio.
#
# This is deliberately a script and not a CLI feature: the product transcribes
# on-device with SpeechAnalyzer and stays dependency-free; experiments against
# other engines run offline against the saved audio.m4a.
#
# Usage:
#   scripts/parakeet-compare.sh <session-dir>
#
# Needs: ffmpeg, uv (both brew-installable). First run downloads the Parakeet
# model (~2.5GB) into the Hugging Face cache.
set -euo pipefail

SESSION="${1:-}"
[ -n "$SESSION" ] && [ -d "$SESSION" ] || {
	echo "usage: $0 <session-dir>   (a folder containing audio.m4a)" >&2
	exit 64
}
AUDIO="$SESSION/audio.m4a"
[ -f "$AUDIO" ] || { echo "no audio.m4a in $SESSION" >&2; exit 66; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)" >&2; exit 69; }
command -v uvx >/dev/null || { echo "uv not found (brew install uv)" >&2; exit 69; }

WORK=$(mktemp -d /tmp/parakeet-compare.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# Left = me (mic), right = them (system audio) — the store's channel contract.
ffmpeg -hide_banner -loglevel error -i "$AUDIO" \
	-filter_complex "channelsplit=channel_layout=stereo[l][r]" \
	-map "[l]" -ar 16000 "$WORK/me.wav" \
	-map "[r]" -ar 16000 "$WORK/them.wav" -y

OUT="$SESSION/transcript-parakeet.md"
{
	echo "# Parakeet transcript"
	echo
	echo "- Engine: parakeet-mlx (default model), greedy decoding"
	echo "- Generated: $(date '+%Y-%m-%d %H:%M')"
	echo "- Channels transcribed separately from audio.m4a (me = left, them = right)"
	echo
} >"$OUT"

for CH in them me; do
	LABEL=$([ "$CH" = "me" ] && echo "Me (microphone)" || echo "Them (system audio)")
	echo "transcribing $CH channel…" >&2
	uvx parakeet-mlx "$WORK/$CH.wav" \
		--output-format srt --output-dir "$WORK" --output-template "$CH" >/dev/null
	{
		echo "---"
		echo
		echo "## $LABEL"
		echo
		if [ -s "$WORK/$CH.srt" ]; then
			# srt -> "**[mm:ss]** text" lines, mirroring transcript.md's shape.
			awk '
				/^[0-9]+$/ { next }
				/-->/ { split($1, t, "[:,]"); printf "**[%02d:%02d]** ", t[1]*60+t[2], t[3]; next }
				/^$/ { print ""; next }
				{ print $0 }
			' "$WORK/$CH.srt"
		else
			echo "_Nothing transcribed._"
		fi
		echo
	} >>"$OUT"
done

echo "wrote $OUT"
