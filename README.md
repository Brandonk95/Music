# TempoTune

An ad-free tuner and metronome for your phone. It's a PWA (installable web app) served by
[PocketBase](https://pocketbase.io), which also stores your presets, setlists and custom tunings.

## Run it on a server (Docker / CasaOS)

How updates flow: push to `main` on GitHub → the **Build image** GitHub Action publishes
`ghcr.io/brandonk95/music:latest` (amd64 + arm64) → the `tempotune-updater` container on your
server checks every 5 minutes and swaps in the new version. Your data in `pb_data` is kept.

**One-time GitHub setup:** the code lives at `github.com/Brandonk95/Music`. Open the package (your
GitHub profile → Packages → music → Package settings) and make sure its visibility is **Public**, so
the server can pull it without logging in. If you rename the repo, update `image:` and `icon:` in
both compose files.

**CasaOS, option A (import):** App Store → **Custom Install** → Import → paste
[docker-compose.yml](docker-compose.yml) → Install.

**CasaOS, option B (app store source):** App Store → More apps → add this source URL:
`https://github.com/Brandonk95/Music/archive/refs/heads/main.zip`. TempoTune then shows up in the
store, and CasaOS refreshes it from GitHub. It reads [Apps/TempoTune/docker-compose.yml](Apps/TempoTune/docker-compose.yml),
which must stay identical to the root compose file (the Action checks this).

**Plain Docker:**

```bash
docker compose up -d
```

Data lives in `/DATA/AppData/tempotune/pb_data` (the CasaOS convention; change `source:` for other
servers). The app is on port **8090**. For the PocketBase dashboard at `/_/`, either set
`PB_ADMIN_EMAIL` / `PB_ADMIN_PASSWORD` in the compose file (or CasaOS app settings), or open the
one-time setup link printed in the container logs.

The updater mounts the Docker socket, and it only touches containers labelled with the
`tempotune` scope.

Behind Cloudflare or another CDN: each build gives the app's scripts new URLs (`?v=<commit>`),
so cached copies can't go stale after an update. Leave Rocket Loader off, since it rewrites
the app's module scripts.

## Run it on Windows (no Docker)

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1   # downloads pocketbase.exe (once)
powershell -ExecutionPolicy Bypass -File .\start.ps1   # serves on port 8090
```

The `presets` collection is created automatically from `pb_migrations/` on first start.
User sign-up uses PocketBase's built-in `users` collection. If you don't want strangers signing up,
set that collection's **Create rule** to superusers-only in the admin UI and create accounts there.

## Use it on your phone

**Install it:** open TempoTune over your https address, then:
- **Android (Chrome, Edge, Samsung Internet):** tap **Install** on the banner, or Settings → Install app.
- **iPhone / iPad:** in Safari, tap Share ⬆ → **Add to Home Screen**. Settings → Install app shows the
  same steps.

Once installed, it opens full screen and works offline. Long-press the icon for Tuner/Metronome
shortcuts (Android). Installing needs https, so it won't work from a plain `http://192.168…` address.

Browsers only allow microphone access over **HTTPS** (or on `localhost`), so the tuner won't work at a
plain `http://192.168.x.x:8090` address. The metronome will, though. The easiest fix is
Tailscale. On the server:

```bash
tailscale serve --bg 8090
```

Then open the `https://<server>.<tailnet>.ts.net` URL on your phone (with Tailscale running on the
phone too) and choose **Add to Home Screen**. A reverse proxy with a certificate (Caddy, Nginx
Proxy Manager, Cloudflare Tunnel) works too.

## Personalized setup

Creating an account opens an optional questionnaire (skippable; retake anytime under
**Settings → Your setup**, with or without an account). It asks:
- whether you play, direct, or teach
- your instrument
- your groups (marching, concert, orchestra, jazz, pep, rock)
- your experience level
- your group's A (440/442)
- a few extras

It then sets things up for you. For example, B♭ clarinet in marching band gets:
- the tuner showing written notes
- a loud cowbell metronome with an 8-count count-in
- screen flash on the beat

Beginners get a relaxed ±5¢ in-tune range and a 72 BPM start. Jazz gets hi-hat on 2 and 4 with
swing. Directors get concert-pitch chromatic tuning with just-intonation hints and drone 5ths.
Answers are saved to the account (`profile` field on `users`), so signing in on a new phone
applies the same setup automatically.

## Band & orchestra

Pick your instrument from the tuner's instrument menu (Woodwinds, Brass, Percussion):
- Shows the **written** note for your part (B♭ clarinet playing concert B♭ shows **C**), with
  the concert pitch underneath. Covers piccolo through contrabass clarinet, all saxes, trumpet,
  flugelhorn, horn, mellophone, trombones, euphonium/baritone (bass or treble clef), tuba/sousaphone,
  timpani, and mallets (with octave transpositions).
- Wind instruments get "push in / pull out" hints.
- **Tuning notes & drone** (♪ Tone): concert B♭/A/F/E♭ shortcuts, any note in any octave, each
  labelled with what you finger. You can add a pure 5th to the drone.
- **Just intonation** (tap `A4 = 440`): pick the concert key and the tuner targets pure chord
  tuning, e.g. "major 3rd of B♭ (−14¢)" or "5th of B♭ (+2¢)".
- Metronome: count-ins of 1–2 bars or 4/8 counts, **drill set length** (stops after 8/16/32… counts,
  with a live "Count 12 of 16"), a bar counter, and loud sounds (cowbell, rimshot, woodblock).

## Group metronome (sectionals)

Play one metronome on everyone's phone, in sync, without everybody fiddling with their own.
The host needs an account; everyone else can join as a guest with just their name.

1. The section leader opens **Metronome → 👥 Group → Start a group** and reads out the 6-character code.
2. Everyone else taps **👥 Group**, enters their name (if not signed in) and the code, and taps **Join**. Each phone first plays a few
   quick clicks to measure its own speaker delay (keep quiet for a second).
3. The host presses **▶**. Everyone holds their phone near the host's for a few beats: each phone
   listens, locks onto the host's clicks, then joins in. The group bar turns green ("In sync ±1 ms").

While it runs, the host's controls work for everyone:

- **Pause** (the Tap button): every phone goes silent on the next beat but keeps counting, so you
  can stop and talk, then **Resume** comes back in exactly on the beat. Nobody re-syncs.
- **■** stops and resets; **▶** starts again after a short count-off. Still no re-sync.
- Tempo, meter, accents, subdivision and sound changes go to everyone. Tempo and meter changes
  start on the next downbeat, so the grid never jumps.
- Players' tempo controls are locked while they're in a group. **End group** in the group sheet
  closes it for everyone, and their own settings come back.

How it works: every phone keeps a clock locked to the server's (`/api/time`), and the host
publishes the beat grid on that clock (start time, tempo, meter). That alone usually gets
within ~10–30 ms. The mic step removes the rest: each phone hears the host's clicks
(the host's speaker and air delay, plus its own mic delay) and subtracts its own measured
speaker-to-mic delay, so its clicks come out of its speaker when the host's do.

Notes:
- If a phone can't hear the host (too loud, too far), tap the group bar → **Sync with host** again,
  or **Follow without the mic** (network clock only, less exact).
- Bluetooth speakers and headphones add a lot of delay that can't be measured this way. Use the
  phone speaker, or recalibrate with the Bluetooth speaker held next to the mic.
- iPhone: if a phone stays silent, check the ringer switch. Keep the app in front, since iOS pauses
  web audio in the background. Syncing briefly uses the mic, which can make the speaker quieter
  for a moment.
- Parties left open are cleaned up after a day (`pb_hooks/tempotune.pb.js`).

## Features

**Tuner**
- Chromatic mode plus 30+ instrument tunings (guitar 6/7/8-string, drop/open tunings, bass 4/5/6,
  ukulele, violin family, mandolin, banjo, bouzouki), and custom tunings you can save
- Auto string detection, or tap a string to lock it (and hear it)
- Needle or strobe display (tap the meter to switch), plus a scrolling pitch-history graph
- Cents and Hz readout, in-tune lock with a ✓ per string
- A4 calibration 415–466 Hz, sharps/flats/solfège names, B♭/E♭/F transposition
- Reference tones: per-string drone, plus a pitch pipe for chromatic mode
- Adjustable in-tune range and mic sensitivity

**Metronome**
- 20–400 BPM: drag the number, tap it to type, +/- (hold to repeat), slider, tap tempo
- Time signatures 1–16 beats over /2, /4, /8, /16, with per-beat accent/normal/soft/mute
- 13 subdivisions (8ths, triplets, 16ths, quintuplets, sextuplets, swing, dotted, gallops…)
- 8 synthesized sounds, with volume and subdivision volume
- Speed trainer, gap trainer, random mute, one-bar count-in
- Practice timer with auto-stop
- Presets and setlists (◀ ▶ through songs on stage)
- Screen flash, vibration (Android), keep-screen-awake, and visual latency offset for Bluetooth

**General**: works offline once loaded, can be installed to the home screen, and syncs to your
account when signed in. Without an account, everything is saved on the device.

Keyboard (desktop): Space play/stop, ←/→ or ↑/↓ change tempo (Shift = ±10), T tap, P pause (group host).

## Layout

```
pb_public/        the web app (PocketBase serves this folder)
  js/pitch.js     McLeod pitch detection (FFT-accelerated)
  js/tuner.js     tuner UI
  js/metronome-engine.js  lookahead audio scheduler
  js/metronome.js metronome UI, presets, setlists
  js/store.js     local + PocketBase storage
  js/clock.js     server-clock sync for the group metronome
  js/acoustic.js  mic onset timing (acoustic sync)
  js/party.js     group metronome (host/member logic); party-ui.js is its UI
pb_migrations/    creates the "presets", "parties" and "party_members" collections
pb_hooks/         /api/time and cleanup of old groups
```
