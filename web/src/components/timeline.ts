import type { AnalysisData } from "@/lib/audio/engine";
import { chordRoot, lastAtOrBefore } from "@/lib/audio/snapshot";
import { hzToMidi } from "@/lib/audio/theory";

export const AXIS_H = 18;
export const LANES = [
  { id: "sections", label: "Section", h: 22 },
  { id: "chords", label: "Chord", h: 30 },
  { id: "beats", label: "Beat", h: 14 },
  { id: "chroma", label: "Chroma", h: 72 },
  { id: "pitch", label: "Pitch", h: 84 },
  { id: "level", label: "Level", h: 36 },
] as const;
export const LANE_GAP = 4;
export const TIMELINE_H = AXIS_H + LANES.reduce((s, l) => s + l.h + LANE_GAP, 0);

const PITCH_LO = 36; // C2
const PITCH_HI = 84; // C6

export interface Palette {
  laneBg: string;
  grid: string;
  text: string;
  muted: string;
  accent: string;
  beat: string;
  dark: boolean;
}

export function readPalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    laneBg: v("--lane-bg"),
    grid: v("--grid"),
    text: v("--text"),
    muted: v("--muted"),
    accent: v("--accent-2"),
    beat: v("--text"),
    dark: v("--is-dark") === "1",
  };
}

export function rootColor(root: number, dark: boolean): string {
  const h = (root * 30 + 10) % 360;
  return dark ? `hsl(${h} 38% 32%)` : `hsl(${h} 70% 86%)`;
}

export function sectionColor(label: string, dark: boolean): string {
  const h = ((label.charCodeAt(0) - 65) * 67 + 200) % 360;
  return dark ? `hsl(${h} 30% 26%)` : `hsl(${h} 45% 90%)`;
}

/** Size the canvas backing store for crisp drawing, keeping under browser canvas limits. */
export function sizeCanvas(c: HTMLCanvasElement, cssW: number, cssH: number): CanvasRenderingContext2D {
  const dpr = Math.min(window.devicePixelRatio || 1, 16000 / Math.max(1, cssW));
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

function niceStep(secPerPx: number): number {
  const target = secPerPx * 90;
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]) if (s >= target) return s;
  return 600;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function drawTimeline(
  g: CanvasRenderingContext2D,
  d: AnalysisData,
  t0: number,
  t1: number,
  width: number,
  pal: Palette,
): void {
  const span = Math.max(1e-6, t1 - t0);
  const pps = width / span;
  const x = (t: number) => (t - t0) * pps;
  g.clearRect(0, 0, width, TIMELINE_H);
  g.font = "11px ui-sans-serif, system-ui, sans-serif";
  g.textBaseline = "middle";

  // Lane layout
  const top: Record<string, number> = {};
  let y = AXIS_H;
  for (const l of LANES) {
    top[l.id] = y;
    g.fillStyle = pal.laneBg;
    g.fillRect(0, y, width, l.h);
    y += l.h + LANE_GAP;
  }

  // Time grid + axis
  const step = niceStep(1 / pps);
  g.fillStyle = pal.muted;
  g.strokeStyle = pal.grid;
  g.lineWidth = 1;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const px = Math.round(x(t)) + 0.5;
    g.beginPath();
    g.moveTo(px, AXIS_H - 4);
    g.lineTo(px, TIMELINE_H);
    g.stroke();
    if (px + 30 < width) g.fillText(fmt(t), px + 3, AXIS_H / 2);
  }

  const visible = <T>(items: T[], start: (x: T) => number) => {
    const i = Math.max(0, lastAtOrBefore(items, t0, start));
    return items.slice(i);
  };

  // Sections
  {
    const yy = top.sections;
    const h = LANES[0].h;
    for (const s of visible(d.sections, (s) => s.t)) {
      if (s.t > t1) break;
      const a = x(s.t);
      const b = x(s.end ?? d.duration);
      g.fillStyle = sectionColor(s.label, pal.dark);
      g.fillRect(a, yy, Math.max(1, b - a - 1), h);
      g.fillStyle = pal.text;
      if (b - a > 14) g.fillText(s.label, Math.max(a, 0) + 5, yy + h / 2);
    }
  }

  // Chords
  {
    const yy = top.chords;
    const h = LANES[1].h;
    g.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    for (const c of visible(d.chords, (c) => c.t)) {
      if (c.t > t1) break;
      if (c.name === "N") continue;
      const a = x(c.t);
      const b = x(c.end ?? d.duration);
      g.fillStyle = rootColor(chordRoot(c.label), pal.dark);
      g.fillRect(a, yy, Math.max(1, b - a - 1), h);
      const w = g.measureText(c.name).width;
      if (b - a > w + 8) {
        g.fillStyle = pal.text;
        g.fillText(c.name, Math.max(a, 0) + 4, yy + h / 2);
      }
    }
    g.font = "11px ui-sans-serif, system-ui, sans-serif";
  }

  // Beats
  {
    const yy = top.beats;
    const h = LANES[2].h;
    g.fillStyle = pal.beat;
    const i0 = Math.max(0, lastAtOrBefore(d.beats, t0, (b) => b));
    for (let i = i0; i < d.beats.length && d.beats[i] <= t1; i++) g.fillRect(Math.round(x(d.beats[i])), yy + 2, 1.5, h - 4);
  }

  // Chromagram (C at the bottom)
  {
    const yy = top.chroma;
    const h = LANES[3].h;
    const rowH = h / 12;
    const fw = Math.max(1, 0.1 * pps + 0.5);
    g.fillStyle = pal.accent;
    const i0 = Math.max(0, lastAtOrBefore(d.frames, t0, (f) => f.t));
    // When zoomed far out, skip frames that land on the same pixel
    const stride = Math.max(1, Math.floor(1 / (0.1 * pps)));
    for (let i = i0; i < d.frames.length && d.frames[i].t <= t1; i += stride) {
      const f = d.frames[i];
      const px = x(f.t - 0.1);
      for (let k = 0; k < 12; k++) {
        const v = f.chroma[k] / 255;
        if (v < 0.08) continue;
        g.globalAlpha = v * v;
        g.fillRect(px, yy + h - (k + 1) * rowH, fw, rowH);
      }
    }
    g.globalAlpha = 1;
  }

  // Pitch
  {
    const yy = top.pitch;
    const h = LANES[4].h;
    g.strokeStyle = pal.grid;
    for (let m = PITCH_LO; m <= PITCH_HI; m += 12) {
      const py = Math.round(yy + h - ((m - PITCH_LO) / (PITCH_HI - PITCH_LO)) * h) + 0.5;
      g.beginPath();
      g.moveTo(0, py);
      g.lineTo(width, py);
      g.stroke();
    }
    g.fillStyle = pal.muted;
    g.fillText("C4", 2, yy + h - ((60 - PITCH_LO) / (PITCH_HI - PITCH_LO)) * h - 6);
    g.strokeStyle = pal.accent;
    g.lineWidth = 2;
    g.beginPath();
    let prevT = -1;
    const i0 = Math.max(0, lastAtOrBefore(d.pitch, t0, (p) => p[0]));
    for (let i = i0; i < d.pitch.length && d.pitch[i][0] <= t1; i++) {
      const [t, hz] = d.pitch[i];
      if (hz <= 0) {
        prevT = -1;
        continue;
      }
      const m = Math.min(PITCH_HI, Math.max(PITCH_LO, hzToMidi(hz)));
      const py = yy + h - ((m - PITCH_LO) / (PITCH_HI - PITCH_LO)) * h;
      if (prevT < 0 || t - prevT > 0.06) g.moveTo(x(t), py);
      else g.lineTo(x(t), py);
      prevT = t;
    }
    g.stroke();
    g.lineWidth = 1;
  }

  // Level (-60..0 dBFS)
  {
    const yy = top.level;
    const h = LANES[5].h;
    g.fillStyle = pal.muted;
    g.globalAlpha = 0.55;
    g.beginPath();
    g.moveTo(x(t0), yy + h);
    const i0 = Math.max(0, lastAtOrBefore(d.frames, t0, (f) => f.t));
    let lastX = x(t0);
    for (let i = i0; i < d.frames.length && d.frames[i].t <= t1; i++) {
      const f = d.frames[i];
      const v = Math.min(1, Math.max(0, (f.db + 60) / 60));
      lastX = x(f.t);
      g.lineTo(lastX, yy + h - v * h);
    }
    g.lineTo(lastX, yy + h);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
  }
}

export function laneTops(): Record<string, number> {
  const out: Record<string, number> = {};
  let y = AXIS_H;
  for (const l of LANES) {
    out[l.id] = y;
    y += l.h + LANE_GAP;
  }
  return out;
}
