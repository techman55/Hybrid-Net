// Chord vocabulary mirrors CHORD_LABELS in python/common.py (maj, min, 7, maj7, min7, 6, m6, sus2, sus4, 5).

export const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export interface ChordType {
  id: string; // Hybrid-Net / MIREX quality, e.g. "maj", "min7"
  suffix: string; // display suffix, e.g. "", "m7"
  intervals: number[];
  prior: number; // multiplier that keeps richer chords from stealing plain triads
}

export const CHORD_TYPES: ChordType[] = [
  { id: "maj", suffix: "", intervals: [0, 4, 7], prior: 1.0 },
  { id: "min", suffix: "m", intervals: [0, 3, 7], prior: 1.0 },
  { id: "7", suffix: "7", intervals: [0, 4, 7, 10], prior: 0.955 },
  { id: "maj7", suffix: "maj7", intervals: [0, 4, 7, 11], prior: 0.95 },
  { id: "min7", suffix: "m7", intervals: [0, 3, 7, 10], prior: 0.955 },
  { id: "6", suffix: "6", intervals: [0, 4, 7, 9], prior: 0.93 },
  { id: "m6", suffix: "m6", intervals: [0, 3, 7, 9], prior: 0.93 },
  { id: "sus2", suffix: "sus2", intervals: [0, 2, 7], prior: 0.925 },
  { id: "sus4", suffix: "sus4", intervals: [0, 5, 7], prior: 0.925 },
  { id: "5", suffix: "5", intervals: [0, 7], prior: 0.9 },
];

export interface ChordGuess {
  name: string; // "Am7", "C/E", "N"
  label: string; // "A:min7", "C:maj/E", "N"
  root: number; // -1 for N
  score: number;
}

export const NO_CHORD: ChordGuess = { name: "N", label: "N", root: -1, score: 0 };

/** Template-match a smoothed chroma (and bass chroma) against the chord vocabulary. */
export function matchChord(chroma: ArrayLike<number>, bass: ArrayLike<number>, bassWeight: number): ChordGuess {
  let norm = 0;
  for (let i = 0; i < 12; i++) norm += chroma[i] * chroma[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-9) return NO_CHORD;

  let bassMax = 0;
  for (let i = 0; i < 12; i++) bassMax = Math.max(bassMax, bass[i]);

  let best = { root: -1, type: CHORD_TYPES[0], score: -1 };
  for (let root = 0; root < 12; root++) {
    for (const type of CHORD_TYPES) {
      let dot = 0;
      for (const iv of type.intervals) dot += chroma[(root + iv) % 12];
      let score = (dot / (Math.sqrt(type.intervals.length) * norm)) * type.prior;
      // Bass on the root breaks ties like C6 vs Am7 or Csus2 vs Gsus4
      if (bassMax > 0) score += 0.05 * bassWeight * (bass[root] / bassMax);
      if (score > best.score) best = { root, type, score };
    }
  }
  if (best.score < 0.5) return { ...NO_CHORD, score: best.score };

  let name = NOTES[best.root] + best.type.suffix;
  let label = `${NOTES[best.root]}:${best.type.id}`;

  // Inversion: a strong bass note that is a chord tone but not the root
  if (bassMax > 0 && bassWeight > 0.25) {
    let bpc = 0;
    for (let i = 1; i < 12; i++) if (bass[i] > bass[bpc]) bpc = i;
    const iv = (bpc - best.root + 12) % 12;
    if (bpc !== best.root && best.type.intervals.includes(iv) && bass[best.root] / bassMax < 0.45) {
      name += `/${NOTES[bpc]}`;
      label += `/${NOTES[bpc]}`;
    }
  }
  return { name, label, root: best.root, score: best.score };
}

// Krumhansl–Kessler key profiles
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyGuess {
  name: string; // "A minor"
  tonic: number;
  mode: "major" | "minor";
  score: number; // Pearson r, -1..1
}

function pearson(a: ArrayLike<number>, b: number[], rot: number): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export function estimateKey(chroma: ArrayLike<number>): KeyGuess | null {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += chroma[i];
  if (sum <= 0) return null;
  let best: KeyGuess | null = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ["major", "minor"] as const) {
      const r = pearson(chroma, mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE, tonic);
      if (!best || r > best.score) best = { name: `${NOTES[tonic]} ${mode}`, tonic, mode, score: r };
    }
  }
  return best;
}

export function midiToName(midi: number): string {
  const r = Math.round(midi);
  return `${NOTES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}
