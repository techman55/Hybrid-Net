import type { AnalysisData } from "./engine";

export type Summary = ReturnType<import("./engine").AnalysisEngine["summary"]>;

export function toJSON(data: AnalysisData, summary: Summary): string {
  return JSON.stringify({ app: "hybrid-net-live", version: 1, summary, ...data }, null, 2);
}

export function toCSV(data: AnalysisData): string {
  const rows: (string | number)[][] = [["type", "start", "end", "value", "confidence"]];
  for (const s of data.sections) rows.push(["section", s.t, s.end ?? "", s.label, ""]);
  for (const k of data.keys) rows.push(["key", k.t, "", k.key, k.confidence]);
  for (const c of data.chords) rows.push(["chord", c.t, c.end ?? "", c.name, c.confidence]);
  let lastBpm = -1;
  for (const p of data.tempo) {
    if (Math.abs(p.bpm - lastBpm) < 1) continue;
    lastBpm = p.bpm;
    rows.push(["tempo", p.t, "", p.bpm, p.confidence]);
  }
  for (const b of data.beats) rows.push(["beat", b, "", "", ""]);
  for (const n of data.notes) rows.push(["note", n.t, n.end ?? "", n.note, ""]);
  rows.sort((a, b) => (a[0] === "type" ? -1 : b[0] === "type" ? 1 : Number(a[1]) - Number(b[1])));
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

/** Audacity label track: start<TAB>end<TAB>label */
export function toAudacityLabels(data: AnalysisData): string {
  const lines: [number, number, string][] = [];
  for (const s of data.sections) lines.push([s.t, s.end ?? data.duration, `[${s.label}]`]);
  for (const c of data.chords) if (c.name !== "N") lines.push([c.t, c.end ?? data.duration, c.name]);
  lines.sort((a, b) => a[0] - b[0]);
  return lines.map(([a, b, l]) => `${a.toFixed(3)}\t${b.toFixed(3)}\t${l}`).join("\n");
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function download(name: string, content: Blob | string, type = "text/plain"): void {
  const blob = typeof content === "string" ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function fmtTime(t: number, ms = true): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${(ms ? s.toFixed(1) : Math.floor(s).toString()).padStart(ms ? 4 : 2, "0")}`;
}
