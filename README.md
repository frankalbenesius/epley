# epley

A hands-free, sensor-guided Epley maneuver for BPPV vertigo, at [epley.frank.dev](https://epley.frank.dev).

Hold your phone flat against the side of your head; it senses when you reach each
position, runs the 30-second holds, and cues you with speech + a beep so you can keep
your eyes closed. Not a diagnostic tool — it's for people whose doctor has already
diagnosed BPPV and told them which ear is affected.

## How it works

- **Ear selection** parameterizes every turn direction (toward the affected ear, then away).
- **Detection** uses `devicemotion`'s gravity vector: a step advances when the gravity
  direction changes past a threshold from the previous position *and* stays stable.
  Absolute head angles aren't measured — it confirms "you moved to a new position and
  held it," which pairs with the timer and clear cues.
- The upright 45° setup turn is a manual "I'm in position" tap (rotating about the
  gravity axis is invisible to the accelerometer).
- Every step has a manual button fallback, so it works even if sensors are denied.

## Files

- `public/index.html`, `style.css`, `app.js` — the app (vanilla, no build step).
- `public/sensor.html` — raw sensor readout, kept for debugging on new devices.

## Deploy

Static site, no build. Push to `main` → GitHub Actions rsyncs `public/` to the homelab
VPS at `/opt/homelab/sites/epley/`, served by Caddy at `epley.frank.dev` (wildcard DNS).
