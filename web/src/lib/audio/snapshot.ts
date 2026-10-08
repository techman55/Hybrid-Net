import type { AnalysisData, AnalysisEngine } from "./engine";
import { hzToMidi, midiToName, NOTES } from "./theory";

/** What the live tiles show — either from the running engine or looked up at a playback time. */
export interface Snapshot {
  t: number;
  db: number;
  chord: string;
  chordSince: number;
  key: string | null;
  keyConfidence: number;
  bpm: number;
  tempoConfidence: number;
  note: string | null;
  cents: number;
  hz: number;
  section: string;
  chroma: number[]; // 0..1
}

export const EMPTY_SNAPSHOT: Snapshot = {
  t: 0,
  db: -120,
  chord: "N",
  chordSince: 0,
  key: null,
  keyConfidence: 0,
  bpm: 0,
  tempoConfidence: 0,
  note: null,
  cents: 0,
  hz: 0,
  section: "A",
  chroma: new Array(12).fill(0),
};

export function snapshotFromEngine(e: AnalysisEngine): Snapshot {
  const L = e.live;
  let mx = 0;
  for (let i = 0; i < 12; i++) mx = Math.max(mx, L.chroma[i]);
  return {
    t: L.t,
    db: L.db,
    chord: L.chord.name,
    chordSince: L.chordSince,
    key: L.key,
    keyConfidence: L.keyConfidence,
    bpm: L.bpm,
    tempoConfidence: L.tempoConfidence,
    note: L.note,
    cents: L.pitchCents,
    hz: L.pitchHz,
    section: L.section,
    chroma: Array.from(L.chroma, (v) => (mx > 0 ? v / mx : 0)),
  };
}

/** Index of the last item with item.t <= t (items sorted by t), or -1. */
export function lastAtOrBefore<T>(items: T[], t: number, get: (x: T) => number): number {
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (get(items[mid]) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function snapshotAt(d: AnalysisData, t: number): Snapshot {
  const ci = lastAtOrBefore(d.chords, t, (c) => c.t);
  const chord = ci >= 0 ? d.chords[ci] : null;
  const ki = lastAtOrBefore(d.keys, t, (k) => k.t);
  const ti = lastAtOrBefore(d.tempo, t, (p) => p.t);
  const si = lastAtOrBefore(d.sections, t, (s) => s.t);
  const pi = lastAtOrBefore(d.pitch, t, (p) => p[0]);
  const fi = lastAtOrBefore(d.frames, t, (f) => f.t);
  const hz = pi >= 0 ? d.pitch[pi][1] : 0;
  const midi = hz > 0 ? hzToMidi(hz) : 0;
  const frame = fi >= 0 ? d.frames[fi] : null;
  return {
    t,
    db: frame?.db ?? -120,
    chord: chord && (chord.end === null || chord.end > t) ? chord.name : "N",
    chordSince: chord?.t ?? 0,
    key: ki >= 0 ? d.keys[ki].key : null,
    keyConfidence: ki >= 0 ? d.keys[ki].confidence : 0,
    bpm: ti >= 0 ? d.tempo[ti].bpm : 0,
    tempoConfidence: ti >= 0 ? d.tempo[ti].confidence : 0,
    note: hz > 0 ? midiToName(midi) : null,
    cents: hz > 0 ? Math.round((midi - Math.round(midi)) * 100) : 0,
    hz,
    section: si >= 0 ? d.sections[si].label : "A",
    chroma: frame ? frame.chroma.map((v) => v / 255) : new Array(12).fill(0),
  };
}

export function chordRoot(label: string): number {
  return NOTES.indexOf(label.split(":")[0] as (typeof NOTES)[number]);
}
