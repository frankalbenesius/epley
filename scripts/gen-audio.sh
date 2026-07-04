#!/usr/bin/env bash
# gen-audio.sh — pre-generate the spoken guidance clips with macOS `say`.
#
# The app plays these static files instead of live speechSynthesis, which is
# unreliable on mobile (throttled when the screen dims, events drop mid-utterance).
# Re-run this after editing any wording, or change VOICE to swap the voice
# (`say -v '?'` lists installed voices; install more in System Settings > Accessibility).
#
# Usage: ./scripts/gen-audio.sh

set -euo pipefail
VOICE="${VOICE:-Samantha}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/audio"

clip() { # clip <relative/path/no-ext> <text>
  local dest="$OUT/$1"
  mkdir -p "$(dirname "$dest")"
  say -v "$VOICE" -o "$dest.aiff" "$2"
  afconvert -f m4af -d 'aac@44100' "$dest.aiff" "$dest.m4a"
  rm -f "$dest.aiff"
  echo "  ✓ $1.m4a"
}

echo "Generating shared clips (voice: $VOICE)…"
clip shared/audio_test "Audio is working. You can close your eyes and just follow along."
clip shared/starting   "Okay. Here we go."
clip shared/hold30     "Hold this position for thirty seconds."
clip shared/reminder   "When you're in position, hold still, and I'll start the timer."
clip shared/sit_up     "Great. Now slowly sit up, back to the edge of the bed."
clip shared/settle     "Stay sitting for a moment while it settles."
clip shared/done       "All done. Stay sitting for a few minutes before you stand up."

for EAR in left right; do
  if [ "$EAR" = "left" ]; then OTHER=right; else OTHER=left; fi
  echo "Generating $EAR-ear clips…"
  clip "$EAR/setup"     "Sit on the edge of the bed, and hold the phone against your $EAR ear. Turn your head forty-five degrees toward your $EAR side. Then hold still, and I'll begin on my own."
  clip "$EAR/lie_back"  "Now lie back quickly. Keep your head turned toward your $EAR side, so your head hangs a little off the edge of the bed."
  clip "$EAR/turn_head" "Now turn just your head, about ninety degrees toward your $OTHER side. Keep your body flat on the bed, and turn until you're looking part way toward the floor."
  clip "$EAR/roll"      "Now roll your whole body onto your $OTHER side. Not just your head — your whole body — until you're facing down toward the floor."
done

echo "Done. Clips in public/audio/"
