import { FFT, hann } from "./fft";
import { estimateKey, hzToMidi, matchChord, midiToName, NO_CHORD, type ChordGuess } from "./theory";

// Analysis frame layout
const W = 2048; // short window: onsets, loudness, timbre, pitch
const HOP = 512;
const CW = 8192; // long window: chroma (needs fine low-frequency resolution)
const RING = 16384;
const NB = 8; // timbre bands

const SILENCE_DB = -50;
const BLOCK_SEC = 0.5; // section-analysis resolution
const SMOOTH_HALF = 6; // blocks either side when smoothing section features (6 s window ≈ one 4-bar phrase)
const NOVELTY_HALF = 12; // smoothed blocks on each side of the novelty kernel (6 s)
const PEAK_HALF = 8; // novelty peak must be a local max over ±4 s
const MIN_SECTION_SEC = 8;
const FRAME_SEC = 0.1; // stored feature-frame resolution

export interface ChordEvent {
  t: number;
  end: number | null;
  name: string;
  label: string;
  confidence: number;
}
export interface SectionEvent {
  t: number;
  end: number | null;
  label: string;
}
export interface KeyEvent {
  t: number;
  key: string;
  confidence: number;
}
export interface TempoPoint {
  t: number;
  bpm: number;
  confidence: number;
}
export interface NoteEvent {
  t: number;
  end: number | null;
  note: string;
  midi: number;
  hz: number;
}
export interface FeatureFrame {
  t: number;
  db: number;
  centroid: number;
  chroma: number[]; // 0..255 per pitch class
}

export interface AnalysisData {
  startedAt: string;
  sampleRate: number;
  duration: number;
  chords: ChordEvent[];
  beats: number[];
  tempo: TempoPoint[];
  keys: KeyEvent[];
  sections: SectionEvent[];
  notes: NoteEvent[];
  pitch: [number, number][]; // [t, hz] (0 = unvoiced)
  frames: FeatureFrame[];
}

export interface LiveState {
  t: number;
  db: number;
  centroid: number;
  silent: boolean;
  chord: ChordGuess;
  chordSince: number;
  key: string | null;
  keyConfidence: number;
  bpm: number;
  tempoConfidence: number;
  lastBeat: number;
  pitchHz: number;
  pitchCents: number;
  note: string | null;
  section: string;
  chroma: Float64Array;
}

export class AnalysisEngine {
  readonly sr: number;
  readonly fps: number;
  data: AnalysisData;
  live: LiveState;

  private fftS = new FFT(W);
  private fftC = new FFT(CW);
  private winS = hann(W);
  private winC = hann(CW);
  private ring = new Float32Array(RING);
  private ringPos = 0;
  private sinceHop = 0;
  private bufS = new Float32Array(W);
  private bufC = new Float32Array(CW);
  private magS = new Float32Array(W / 2 + 1);
  private magC = new Float32Array(CW / 2 + 1);
  private prevLog = new Float32Array(W / 2 + 1);
  private bandOf: Int8Array;
  private yinBuf: Float32Array;

  private frame = 0;
  private odf: number[] = [];
  private env: number[] = [];
  private lastLoudT = -Infinity;

  // chord
  private chromaS = new Float64Array(12);
  private bassS = new Float64Array(12);
  private bassRel = 0;
  private cand: ChordGuess = NO_CHORD;
  private candT = 0;
  private candN = 0;
  private curChord: ChordEvent | null = null;

  // key
  private keyRecent = new Float64Array(12);
  private keyLong = new Float64Array(12);
  private keyCand: string | null = null;
  private keyCandN = 0;

  // tempo / beat
  private bpmPending = 0;
  private bpmPendingN = 0;
  private nextBeatF = Infinity;

  // pitch
  private curNote: NoteEvent | null = null;
  private noteHz: number[] = [];
  private unvoicedSince = 0;

  // feature frames and section blocks
  private frameAcc = { n: 0, db: -120, centroid: 0, chroma: new Float64Array(12), chromaN: 0 };
  private blockAcc = { chroma: new Float64Array(12), bands: new Float64Array(NB), n: 0 };
  private bandE = new Float64Array(NB);
  private blocks: Float32Array[] = [];
  private smoothed: Float32Array[] = [];
  private novelty: number[] = [];
  private lastBoundaryBlock = 0;

  onBeat?: (t: number) => void;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.fps = sampleRate / HOP;
    this.yinBuf = new Float32Array(Math.ceil(sampleRate / 60) + 2);

    // Log-spaced timbre bands, 60 Hz – 12 kHz
    this.bandOf = new Int8Array(W / 2 + 1).fill(-1);
    const lo = Math.log(60);
    const hi = Math.log(12000);
    for (let k = 1; k <= W / 2; k++) {
      const f = (k * sampleRate) / W;
      if (f < 60 || f >= 12000) continue;
      this.bandOf[k] = Math.min(NB - 1, Math.floor(((Math.log(f) - lo) / (hi - lo)) * NB));
    }

    this.data = {
      startedAt: new Date().toISOString(),
      sampleRate,
      duration: 0,
      chords: [],
      beats: [],
      tempo: [],
      keys: [],
      sections: [{ t: 0, end: null, label: "A" }],
      notes: [],
      pitch: [],
      frames: [],
    };
    this.live = {
      t: 0,
      db: -120,
      centroid: 0,
      silent: true,
      chord: NO_CHORD,
      chordSince: 0,
      key: null,
      keyConfidence: 0,
      bpm: 0,
      tempoConfidence: 0,
      lastBeat: -1,
      pitchHz: 0,
      pitchCents: 0,
      note: null,
      section: "A",
      chroma: new Float64Array(12),
    };
  }

  /** Feed mono samples at this.sr. */
  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.ringPos] = samples[i];
      this.ringPos = (this.ringPos + 1) & (RING - 1);
      if (++this.sinceHop === HOP) {
        this.sinceHop = 0;
        this.processHop();
      }
    }
  }

  /** Close open events. Call once when recording stops. */
  finish(): AnalysisData {
    const end = this.data.duration;
    if (this.curChord) this.curChord.end = end;
    this.endNote(end);
    const last = this.data.sections[this.data.sections.length - 1];
    last.end = end;
    this.relabelSections();
    return this.data;
  }

  summary() {
    const d = this.data;
    const key = estimateKey(this.keyLong);
    const confident = d.tempo.filter((p) => p.confidence >= 0.3).map((p) => p.bpm).sort((a, b) => a - b);
    const bpm = confident.length ? confident[Math.floor(confident.length / 2)] : null;
    const chordTime = new Map<string, number>();
    for (const c of d.chords) {
      if (c.name === "N") continue;
      chordTime.set(c.name, (chordTime.get(c.name) ?? 0) + ((c.end ?? d.duration) - c.t));
    }
    return {
      duration: round(d.duration),
      bpm: bpm === null ? null : Math.round(bpm * 10) / 10,
      key: key?.name ?? null,
      keyConfidence: key ? round(key.score) : 0,
      beatCount: d.beats.length,
      chordChanges: d.chords.filter((c) => c.name !== "N").length,
      chordsUsed: [...chordTime.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, seconds]) => ({ name, seconds: round(seconds) })),
      form: d.sections.map((s) => s.label).join(" "),
    };
  }

  // ---------------------------------------------------------------------------

  private timeOf(frame: number): number {
    return Math.max(0, ((frame + 1) * HOP - W / 2) / this.sr);
  }

  private readLast(out: Float32Array): void {
    const n = out.length;
    let p = (this.ringPos - n + RING) & (RING - 1);
    for (let i = 0; i < n; i++) {
      out[i] = this.ring[p];
      p = (p + 1) & (RING - 1);
    }
  }

  private processHop(): void {
    const i = this.frame++;
    const t = this.timeOf(i);
    const L = this.live;
    this.data.duration = t;
    L.t = t;

    this.readLast(this.bufS);
    let e = 0;
    for (let k = W - HOP * 2; k < W; k++) e += this.bufS[k] * this.bufS[k];
    const db = 10 * Math.log10(e / (HOP * 2) + 1e-12);
    L.db = db;
    if (db > SILENCE_DB) this.lastLoudT = t;
    L.silent = t - this.lastLoudT > 0.4;

    // Short-window spectrum: onset strength, centroid, timbre bands
    this.fftS.magnitude(this.bufS, this.winS, this.magS);
    const norm = 4 / W;
    let flux = 0;
    let num = 0;
    let den = 0;
    const kMax = Math.min(W / 2, Math.floor((11000 * W) / this.sr));
    for (let k = 1; k <= kMax; k++) {
      const m = this.magS[k] * norm;
      const l = Math.log1p(100 * m);
      const d = l - this.prevLog[k];
      if (d > 0) flux += d;
      this.prevLog[k] = l;
      num += k * m;
      den += m;
      const b = this.bandOf[k];
      if (b >= 0) this.bandE[b] += m * m;
    }
    const centroid = den > 1e-9 ? ((num / den) * this.sr) / W : 0;
    L.centroid = centroid;

    this.odf.push(flux);
    const n = this.odf.length;
    let mean = 0;
    const from = Math.max(0, n - 24);
    for (let j = from; j < n; j++) mean += this.odf[j];
    mean /= n - from;
    this.env.push(Math.max(0, flux - mean));

    if (i % 2 === 0) this.pitchStep(t, db);
    if (i % 4 === 0) this.chromaStep(t, db);
    if (i % Math.round(this.fps) === 0 && i > 0) {
      this.tempoStep(t);
      this.keyStep(t);
    }
    if (i % 8 === 0) this.beatPhaseStep();
    this.beatEmit(i);

    // 0.1 s feature frames
    const fa = this.frameAcc;
    fa.n++;
    fa.db = Math.max(fa.db, db);
    fa.centroid += centroid;
    if (t >= (this.data.frames.length + 1) * FRAME_SEC) {
      const c = fa.chroma;
      let mx = 0;
      for (let k = 0; k < 12; k++) mx = Math.max(mx, c[k]);
      this.data.frames.push({
        t: round(t),
        db: Math.round(fa.db * 10) / 10,
        centroid: Math.round(fa.centroid / fa.n),
        chroma: Array.from(c, (v) => (mx > 0 && fa.chromaN > 0 ? Math.round((v / mx) * 255) : 0)),
      });
      fa.n = 0;
      fa.db = -120;
      fa.centroid = 0;
      fa.chroma.fill(0);
      fa.chromaN = 0;
    }

    // 0.5 s section blocks
    if (t >= (this.blocks.length + 1) * BLOCK_SEC) this.closeBlock();
  }

  private chromaStep(t: number, db: number): void {
    this.readLast(this.bufC);
    this.fftC.magnitude(this.bufC, this.winC, this.magC);
    const m = this.magC;
    const k0 = Math.max(2, Math.ceil((60 * CW) / this.sr));
    const k1 = Math.min(CW / 2 - 1, Math.floor((2100 * CW) / this.sr));
    let peak = 0;
    for (let k = k0; k <= k1; k++) peak = Math.max(peak, m[k]);
    const ch = new Float64Array(12);
    const bass = new Float64Array(12);
    const thr = peak * 0.02;
    for (let k = k0; k <= k1; k++) {
      const a = m[k - 1];
      const b = m[k];
      const c = m[k + 1];
      if (!(b > a && b >= c && b > thr)) continue;
      const la = Math.log(a + 1e-12);
      const lb = Math.log(b + 1e-12);
      const lc = Math.log(c + 1e-12);
      const dn = la - 2 * lb + lc;
      const p = dn !== 0 ? (0.5 * (la - lc)) / dn : 0;
      const f = ((k + p) * this.sr) / CW;
      const midi = hzToMidi(f);
      const r = Math.round(midi);
      const dev = Math.abs(midi - r);
      if (dev > 0.4) continue;
      const w = b * (1 - dev);
      const pc = ((r % 12) + 12) % 12;
      ch[pc] += w;
      if (f < 260) bass[pc] += w;
    }

    let mx = 0;
    let sum = 0;
    let bsum = 0;
    for (let k = 0; k < 12; k++) {
      mx = Math.max(mx, ch[k]);
      sum += ch[k];
      bsum += bass[k];
    }

    const fa = this.frameAcc;
    const ba = this.blockAcc;
    if (mx > 0 && db > SILENCE_DB) {
      for (let k = 0; k < 12; k++) {
        fa.chroma[k] += ch[k] / mx;
        ba.chroma[k] += ch[k] / mx;
      }
      fa.chromaN++;
      ba.n++;

      const alpha = 0.12; // ~0.35 s smoothing at 4-hop updates
      let bmx = 0;
      for (let k = 0; k < 12; k++) bmx = Math.max(bmx, bass[k]);
      for (let k = 0; k < 12; k++) {
        this.chromaS[k] = (1 - alpha) * this.chromaS[k] + alpha * (ch[k] / mx);
        this.bassS[k] = (1 - alpha) * this.bassS[k] + alpha * (bmx > 0 ? bass[k] / bmx : 0);
      }
      this.bassRel = (1 - alpha) * this.bassRel + alpha * (sum > 0 ? bsum / sum : 0);

      const amp = Math.pow(10, db / 20);
      const decay = Math.exp((-4 * HOP) / this.sr / 15); // ~15 s memory for "current key"
      for (let k = 0; k < 12; k++) {
        const v = (ch[k] / sum) * amp;
        this.keyLong[k] += v;
        this.keyRecent[k] = this.keyRecent[k] * decay + v;
      }
    }
    this.live.chroma.set(this.chromaS);
    this.chordStep(t);
  }

  private chordStep(t: number): void {
    const L = this.live;
    const guess = L.silent ? NO_CHORD : matchChord(this.chromaS, this.bassS, Math.min(1, this.bassRel * 4));
    if (guess.name === this.cand.name) {
      this.candN++;
      this.cand = guess;
    } else {
      this.cand = guess;
      this.candT = t;
      this.candN = 1;
    }
    const cur = this.curChord?.name ?? null;
    // Must win ~7 consecutive decisions (~0.3 s) to commit; back-date to when it first appeared
    if (this.cand.name !== cur && this.candN >= 7) {
      if (this.curChord) this.curChord.end = round(this.candT);
      this.curChord = {
        t: round(this.candT),
        end: null,
        name: this.cand.name,
        label: this.cand.label,
        confidence: round(Math.min(1, this.cand.score)),
      };
      this.data.chords.push(this.curChord);
      L.chord = this.cand;
      L.chordSince = this.candT;
    } else if (this.cand.name === cur && this.curChord) {
      this.curChord.confidence = round(Math.min(1, Math.max(this.curChord.confidence, this.cand.score)));
      L.chord = this.cand;
    }
  }

  private keyStep(t: number): void {
    const k = estimateKey(this.keyRecent);
    if (!k) return;
    const L = this.live;
    if (k.name === this.keyCand) this.keyCandN++;
    else {
      this.keyCand = k.name;
      this.keyCandN = 1;
    }
    if (k.name === L.key) L.keyConfidence = k.score;
    // First key after 3 s of evidence, later changes need 4 s of agreement
    const needed = L.key === null ? 3 : 4;
    if (k.name !== L.key && this.keyCandN >= needed && k.score > 0.5) {
      L.key = k.name;
      L.keyConfidence = k.score;
      this.data.keys.push({ t: round(Math.max(0, t - (needed - 1))), key: k.name, confidence: round(k.score) });
    }
  }

  private tempoStep(t: number): void {
    const env = this.env;
    const n = env.length;
    if (n < this.fps * 4) return;
    const win = Math.min(n, Math.round(this.fps * 8));
    const x = new Float64Array(win);
    let mean = 0;
    for (let i = 0; i < win; i++) mean += env[n - win + i];
    mean /= win;
    for (let i = 0; i < win; i++) x[i] = env[n - win + i] - mean;

    const acf = (lag: number): number => {
      const l0 = Math.floor(lag);
      const fr = lag - l0;
      if (l0 + 1 >= win) return 0;
      let s = 0;
      for (let i = l0 + 1; i < win; i++) s += x[i] * (x[i - l0] * (1 - fr) + x[i - l0 - 1] * fr);
      return s / (win - l0);
    };
    const r0 = acf(0) || 1e-12;

    const bpms: number[] = [];
    const scores: number[] = [];
    for (let bpm = 60; bpm <= 200; bpm += 0.5) {
      const lag = (this.fps * 60) / bpm;
      let s = acf(lag) + 0.5 * acf(2 * lag) + 0.33 * acf(3 * lag) + 0.25 * acf(4 * lag);
      const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
      s = s > 0 ? s * prior : s;
      bpms.push(bpm);
      scores.push(s);
    }
    let bi = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
    let bpm = bpms[bi];
    if (bi > 0 && bi < scores.length - 1) {
      const a = scores[bi - 1];
      const b = scores[bi];
      const c = scores[bi + 1];
      const dn = a - 2 * b + c;
      if (dn !== 0) bpm += 0.5 * ((0.5 * (a - c)) / dn);
    }
    const conf = clamp(acf((this.fps * 60) / bpm) / r0 / 0.35, 0, 1);

    const L = this.live;
    if (this.live.silent || conf < 0.1) {
      L.tempoConfidence = conf;
      return;
    }
    if (L.bpm === 0) {
      L.bpm = bpm;
    } else if (Math.abs(bpm - L.bpm) / L.bpm < 0.04) {
      L.bpm = 0.7 * L.bpm + 0.3 * bpm;
      this.bpmPendingN = 0;
    } else if (this.bpmPendingN > 0 && Math.abs(bpm - this.bpmPending) / this.bpmPending < 0.04) {
      if (++this.bpmPendingN >= 3) {
        L.bpm = bpm;
        this.bpmPendingN = 0;
      }
    } else {
      this.bpmPending = bpm;
      this.bpmPendingN = 1;
    }
    L.tempoConfidence = conf;
    this.data.tempo.push({ t: round(t), bpm: Math.round(L.bpm * 10) / 10, confidence: round(conf) });
  }

  private envAt(pos: number): number {
    const r = Math.round(pos);
    const e = this.env;
    return Math.max(e[r - 1] ?? 0, e[r] ?? 0, e[r + 1] ?? 0);
  }

  private beatPhaseStep(): void {
    const bpm = this.live.bpm;
    if (!bpm) return;
    const P = (this.fps * 60) / bpm;
    const n = this.env.length;
    const span = Math.min(n, Math.round(this.fps * 4));
    let best = -1;
    let bestPhi = 0;
    for (let phi = 0; phi < P; phi += 0.5) {
      let s = 0;
      let wk = 1;
      for (let k = 0; ; k++) {
        const pos = n - 1 - phi - k * P;
        if (pos < n - span) break;
        s += wk * this.envAt(pos);
        wk *= 0.85;
      }
      if (s > best) {
        best = s;
        bestPhi = phi;
      }
    }
    // If the most recent beat hasn't been emitted yet, emit it now (back-dated) instead of skipping it
    const lastF = n - 1 - bestPhi;
    const emitted = this.live.lastBeat >= 0 && this.timeOf(lastF) - this.live.lastBeat < (0.6 * 60) / bpm;
    this.nextBeatF = emitted ? lastF + P : lastF;
  }

  private beatEmit(frame: number): void {
    const L = this.live;
    if (!L.bpm || frame < this.nextBeatF) return;
    const P = (this.fps * 60) / L.bpm;
    const tb = this.timeOf(this.nextBeatF);
    this.nextBeatF += P;
    const minGap = (0.6 * 60) / L.bpm;
    if (L.silent || L.tempoConfidence < 0.15) return;
    if (L.lastBeat >= 0 && tb - L.lastBeat < minGap) return;
    L.lastBeat = tb;
    this.data.beats.push(round(tb));
    this.onBeat?.(tb);
  }

  private pitchStep(t: number, db: number): void {
    const L = this.live;
    let hz = 0;
    if (db > SILENCE_DB + 5) {
      const r = yin(this.bufS, this.sr, this.yinBuf);
      if (r && r.confidence > 0.8) hz = r.hz;
    }
    this.data.pitch.push([round(t), Math.round(hz * 10) / 10]);
    L.pitchHz = hz;

    if (hz > 0) {
      const midi = hzToMidi(hz);
      L.pitchCents = Math.round((midi - Math.round(midi)) * 100);
      L.note = midiToName(midi);
      this.unvoicedSince = Infinity;
      const cur = this.curNote;
      if (cur && Math.abs(midi - cur.midi) < 0.6) {
        this.noteHz.push(hz);
      } else {
        this.endNote(t);
        this.curNote = { t: round(t), end: null, note: midiToName(midi), midi: Math.round(midi), hz: 0 };
        this.noteHz = [hz];
      }
    } else {
      L.note = null;
      if (this.unvoicedSince === Infinity) this.unvoicedSince = t;
      if (this.curNote && t - this.unvoicedSince > 0.06) this.endNote(this.unvoicedSince);
    }
  }

  private endNote(t: number): void {
    const cur = this.curNote;
    if (!cur) return;
    this.curNote = null;
    if (t - cur.t < 0.08) return;
    const hzs = [...this.noteHz].sort((a, b) => a - b);
    cur.hz = Math.round(hzs[Math.floor(hzs.length / 2)] * 10) / 10;
    cur.end = round(t);
    this.data.notes.push(cur);
  }

  private closeBlock(): void {
    const ba = this.blockAcc;
    const v = new Float32Array(12 + NB);
    let cn = 0;
    for (let k = 0; k < 12; k++) cn += ba.chroma[k] ** 2;
    cn = Math.sqrt(cn);
    for (let k = 0; k < 12; k++) v[k] = cn > 0 ? ba.chroma[k] / cn : 0;
    let bm = 0;
    const lb = new Float64Array(NB);
    for (let b = 0; b < NB; b++) {
      lb[b] = Math.log10(this.bandE[b] + 1e-10);
      bm += lb[b];
    }
    bm /= NB;
    let bn = 0;
    for (let b = 0; b < NB; b++) {
      lb[b] -= bm;
      bn += lb[b] ** 2;
    }
    bn = Math.sqrt(bn);
    for (let b = 0; b < NB; b++) v[12 + b] = bn > 0 ? (0.6 * lb[b]) / bn : 0;
    this.blocks.push(v);
    ba.chroma.fill(0);
    ba.n = 0;
    this.bandE.fill(0);

    this.noveltyStep();
    if (this.blocks.length % 4 === 0) this.relabelSections();
  }

  private noveltyStep(): void {
    // Smooth blocks over ~4 s first so chord-to-chord motion inside a progression doesn't read as a new section
    const B = this.blocks;
    const S = this.smoothed;
    const i = B.length - SMOOTH_HALF;
    if (i - SMOOTH_HALF < 0) return;
    const dim = B[0].length;
    const v = new Float32Array(dim);
    for (let j = i - SMOOTH_HALF; j < i + SMOOTH_HALF; j++) for (let k = 0; k < dim; k++) v[k] += B[j][k];
    S[i] = v;

    // Foote checkerboard novelty, centred K smoothed blocks back
    const K = NOVELTY_HALF;
    const c = i - K + 1;
    if (c - K < SMOOTH_HALF) return;
    let pp = 0;
    let ff = 0;
    let pf = 0;
    for (let a = c - K; a < c; a++) {
      for (let b = c - K; b < c; b++) pp += cosine(S[a], S[b]);
      for (let b = c; b < c + K; b++) pf += cosine(S[a], S[b]);
    }
    for (let a = c; a < c + K; a++) for (let b = c; b < c + K; b++) ff += cosine(S[a], S[b]);
    this.novelty[c] = Math.max(0, (pp + ff - 2 * pf) / (K * K));

    // Peak must be the max within ±PEAK_HALF and well above the typical novelty level
    const p = c - PEAK_HALF;
    const np = this.novelty[p];
    if (np === undefined) return;
    for (let j = p - PEAK_HALF; j <= p + PEAK_HALF; j++) if (j !== p && (this.novelty[j] ?? 0) > np) return;
    const vals = this.novelty.filter((x) => x !== undefined).sort((a, b) => a - b);
    const median = vals[Math.floor(vals.length / 2)];
    if (np < 0.01 || np < 2 * median) return;

    // Smoothing blurs the exact spot; snap to the sharpest timbre change within ±4 s
    // (timbre only: chroma changes on every chord)
    const tb = (j: number) => B[j].subarray(12);
    let at = p;
    let sharpest = -1;
    for (let j = Math.max(2, p - 8); j <= Math.min(B.length - 2, p + 8); j++) {
      const d = 1 - (cosine(tb(j - 2), tb(j)) + cosine(tb(j - 1), tb(j + 1))) / 2;
      if (d > sharpest) {
        sharpest = d;
        at = j;
      }
    }
    if ((at - this.lastBoundaryBlock) * BLOCK_SEC < MIN_SECTION_SEC) return;

    this.lastBoundaryBlock = at;
    const t = at * BLOCK_SEC;
    const secs = this.data.sections;
    secs[secs.length - 1].end = t;
    secs.push({ t, end: null, label: "?" });
    this.relabelSections();
  }

  /** Group sections that sound alike: A, B, A, C … (not verse/chorus semantics). */
  private relabelSections(): void {
    const B = this.blocks;
    if (!B.length) return;
    const dim = B[0].length;
    const g = new Float64Array(dim);
    for (const b of B) for (let k = 0; k < dim; k++) g[k] += b[k] / B.length;

    const clusters: { label: string; sum: Float64Array }[] = [];
    for (const s of this.data.sections) {
      const i0 = Math.round(s.t / BLOCK_SEC);
      const i1 = s.end === null ? B.length : Math.round(s.end / BLOCK_SEC);
      const v = new Float64Array(dim);
      for (let i = i0; i < Math.min(i1, B.length); i++) for (let k = 0; k < dim; k++) v[k] += B[i][k] - g[k];
      let best = -1;
      let bestSim = 0.55;
      clusters.forEach((cl, idx) => {
        const sim = cosine(v, cl.sum);
        if (sim > bestSim) {
          bestSim = sim;
          best = idx;
        }
      });
      if (best >= 0) {
        s.label = clusters[best].label;
        for (let k = 0; k < dim; k++) clusters[best].sum[k] += v[k];
      } else {
        s.label = String.fromCharCode(65 + Math.min(clusters.length, 25));
        clusters.push({ label: s.label, sum: v });
      }
    }
    this.live.section = this.data.sections[this.data.sections.length - 1].label;
  }
}

/** YIN pitch detector over the second half-window. */
function yin(buf: Float32Array, sr: number, d: Float32Array): { hz: number; confidence: number } | null {
  const half = buf.length / 2;
  const tMin = Math.floor(sr / 1200);
  const tMax = Math.min(half - 1, d.length - 2, Math.ceil(sr / 60));
  d[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tMax + 1; tau++) {
    let s = 0;
    for (let j = 0; j < half; j++) {
      const diff = buf[j] - buf[j + tau];
      s += diff * diff;
    }
    run += s;
    d[tau] = run > 0 ? (s * tau) / run : 1;
  }
  let tau = -1;
  for (let k = tMin; k <= tMax; k++) {
    if (d[k] < 0.15) {
      while (k + 1 <= tMax && d[k + 1] < d[k]) k++;
      tau = k;
      break;
    }
  }
  if (tau < 1) return null;
  const x0 = d[tau - 1];
  const x1 = d[tau];
  const x2 = d[tau + 1];
  const dn = x0 - 2 * x1 + x2;
  const better = dn !== 0 ? tau + (x0 - x2) / (2 * dn) : tau;
  return { hz: sr / better, confidence: 1 - x1 };
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
