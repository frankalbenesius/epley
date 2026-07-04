# epley

A hands-free, sensor-guided Epley maneuver for BPPV vertigo, at [epley.frank.dev](https://epley.frank.dev).

Hold your phone flat against the affected ear; it senses when you reach each position,
runs the 30-second holds, and guides you entirely by voice + cues so you can keep your
eyes closed and never touch the screen. Not a diagnostic tool — it's for people whose
doctor has already diagnosed BPPV and told them which ear is affected.

## How it works

- **Ear selection** parameterizes every turn direction (toward the affected ear, then away).
- **The loop is one state machine** (`app.js`): `ARMING → SEEK → HOLD → ADVANCING`, driven by a
  single 100ms clock. Each phase emits exactly one distinct audio cue.
- **Detection** uses `devicemotion`'s gravity vector: a move is accepted when the gravity
  direction changes past a threshold from the committed reference *and* stays still for a
  settle window. It confirms "you moved to a new position and held it," not exact angles.
- **Voice is pre-generated audio, not live TTS.** Mobile `speechSynthesis` is throttled when
  the screen dims and drops events mid-hold, so instructions are static `.m4a` clips played
  via `<audio>`. A Screen Wake Lock keeps the phone awake during the run.
- **Fallbacks:** timed guidance if motion is denied; a `Back a step` control; and `?debug`
  (append to the URL) opens a panel to drive the whole loop from a desktop browser without
  doing the physical maneuver.

## Regenerating the voice

Clips live in `public/audio/{shared,left,right}/`. Edit the wording or voice and rebuild:

```
./scripts/gen-audio.sh            # uses macOS `say` (voice: Samantha)
VOICE="Ava (Premium)" ./scripts/gen-audio.sh   # or any installed voice
```

## Files

- `public/index.html`, `style.css`, `app.js` — the app (vanilla, no build step).
- `public/audio/**` — pre-generated speech clips.
- `public/sensor.html` — raw sensor readout, kept for debugging on new devices.
- `scripts/gen-audio.sh` — regenerates the speech clips.

## Deploy

Static site, no build. Push to `main` → GitHub Actions rsyncs `public/` to the homelab VPS
at `/opt/homelab/sites/epley/`, served by Caddy at `epley.frank.dev` (wildcard DNS).
