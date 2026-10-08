# Live Music Analyzer (web)

A real-time take on Hybrid-Net that runs in the browser. Click **Record** (or pick an audio file), and it tracks chords, key, tempo, beats, pitch, and song sections with timestamps, then lets you replay, inspect, and export the results.

It's a Next.js app deployed to **Cloudflare Workers** via [OpenNext](https://opennext.js.org/cloudflare). All audio analysis happens in the browser, so audio never leaves your device and the Worker only serves the static page.

## Why it doesn't use the Hybrid-Net models

The Python code in this repo ships model *architectures* only. There are no trained weights, no config, and lyrics are `NotImplementedError`. The models are also offline, whole-song transformers that run source separation over 4096-point STFTs, which is far too heavy for real-time use in a browser. So this app reproduces the same outputs (`bpm`, `key`, `chords`, `beat`, `segment`, `pitch`) with streaming DSP, using the same chord vocabulary as `python/common.py`:

| Feature | Method | Latency |
|---|---|---|
| Chords | Peak-picked chroma (8192-pt FFT) + bass chroma → template match over maj/min/7/maj7/m7/6/m6/sus2/sus4/5, with inversions | ~0.3 s |
| Key | Krumhansl–Kessler profile correlation over decaying chroma (current) and whole-recording chroma (summary) | ~3 s |
| Tempo | Log spectral-flux onset envelope → harmonic-summed autocorrelation, 60–200 BPM | ~4 s |
| Beats | Comb-filter phase tracking on the onset envelope | ~1 beat |
| Pitch / notes | YIN, 60–1200 Hz (monophonic: follows the loudest note) | ~40 ms |
| Sections | Foote novelty on smoothed chroma + timbre, snapped to timbre changes, clustered into A/B/C | ~10 s (back-dated) |

On a synthetic test song (known chords, 97/120/140 BPM, A-B-A form) it gets tempo within 0.1 BPM, beats within ~10 ms, the correct key and chords, and section boundaries within ~2 s. Real recordings will be noisier, especially with dense mixes and on tempo octave errors (e.g. 70 vs 140).

## Exports

- **JSON**: everything, including 10 Hz feature frames (level, spectral centroid, chroma)
- **CSV**: one row per event (`type,start,end,value,confidence`)
- **Audacity labels**: chords and sections as a label track
- **Audio**: the mic recording (WebM/Opus or MP4, depending on the browser)

## Develop

```bash
cd web
npm install
npm run dev          # http://localhost:3000 (mic works on localhost)
npm run typecheck
```

## Deploy to Cloudflare Workers

```bash
npm run preview      # build with OpenNext and run in the local Workers runtime (wrangler dev)
npx wrangler login   # once
npm run deploy       # build and deploy to <name>.<subdomain>.workers.dev
```

The Worker name is set in `wrangler.jsonc` (`hybrid-net-live`). For CI, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and run `npm run deploy`. Microphone access needs HTTPS, which `workers.dev` and custom domains provide.

> `next` is pinned to `~16.3.8`. Next 16.4 adds a `preview-props.json` manifest that `@opennextjs/cloudflare` 1.20.x doesn't inline yet, and the Worker throws at runtime. Bump it once OpenNext supports 16.4.

## Layout

```
src/lib/audio/engine.ts    streaming analysis (all features)
src/lib/audio/theory.ts    chord templates, key profiles
src/lib/audio/fft.ts       radix-2 FFT
src/components/Analyzer.tsx  UI, audio graph, recording, playback
src/components/timeline.ts   canvas timeline renderer
public/tap-worklet.js      AudioWorklet that streams mono samples to the main thread
```
