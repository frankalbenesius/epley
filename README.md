# epley

A guided Epley maneuver for BPPV vertigo, at [epley.frank.dev](https://epley.frank.dev).

Uses the phone's motion sensors (DeviceOrientation API) to detect head position
and advance through the maneuver's steps. Not a diagnostic tool — follow a
clinician-confirmed diagnosis and affected ear.

## Status

Sensor spike: `public/index.html` confirms the phone reports usable pitch/roll on
the target device before building the full guided flow.

## Deploy

Static site, no build step. Push to `main` → GitHub Actions rsyncs `public/` to the
homelab VPS at `/opt/homelab/sites/epley/`, served by Caddy at `epley.frank.dev`.
