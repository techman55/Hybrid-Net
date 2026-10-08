"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnalysisEngine, type AnalysisData } from "@/lib/audio/engine";
import { download, fmtTime, toAudacityLabels, toCSV, toJSON, type Summary } from "@/lib/audio/export";
import { EMPTY_SNAPSHOT, snapshotAt, snapshotFromEngine, type Snapshot } from "@/lib/audio/snapshot";
import { NOTES } from "@/lib/audio/theory";
import { drawTimeline, LANES, LANE_GAP, AXIS_H, readPalette, sizeCanvas, TIMELINE_H } from "./timeline";

type Mode = "idle" | "starting" | "recording" | "review";
type EventType = "section" | "key" | "chord" | "tempo" | "note" | "beat";

interface Session {
  ctx: AudioContext;
  tap: AudioWorkletNode;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  fileEl: HTMLAudioElement | null;
  engine: AnalysisEngine;
}

interface Row {
  t: number;
  end: number | null;
  type: EventType;
  value: string;
  conf: number | null;
}

const LIVE_WINDOW = 20; // seconds visible while recording
const ALL_TYPES: EventType[] = ["section", "key", "chord", "tempo", "note", "beat"];

export default function Analyzer() {
  const [mode, setMode] = useState<Mode>("idle");
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [data, setData] = useState<AnalysisData | null>(null);
  const [version, setVersion] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [audio, setAudio] = useState<{ url: string; name: string; blob: Blob | null } | null>(null);
  const [filters, setFilters] = useState<Set<EventType>>(new Set(["section", "key", "chord", "tempo"]));
  const [zoom, setZoom] = useState(0); // 0 = fit, else px per second
  const [sourceLabel, setSourceLabel] = useState("");

  const session = useRef<Session | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const beatDotRef = useRef<HTMLSpanElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const rafRef = useRef(0);
  const lastBeatShown = useRef(-1);
  const stoppingRef = useRef(false);

  const flashBeat = useCallback(() => {
    const el = beatDotRef.current;
    if (!el) return;
    el.classList.remove("on");
    void el.offsetWidth; // restart the CSS animation
    el.classList.add("on");
  }, []);

  // ---------------------------------------------------------------- recording

  const stop = useCallback(async () => {
    const s = session.current;
    if (!s || stoppingRef.current) return;
    stoppingRef.current = true;
    cancelAnimationFrame(rafRef.current);
    s.tap.port.onmessage = null;
    s.tap.disconnect();
    s.stream?.getTracks().forEach((tr) => tr.stop());
    if (s.fileEl) {
      s.fileEl.onpause = null;
      s.fileEl.onended = null;
      s.fileEl.pause();
    }

    const recorded = await new Promise<Blob | null>((resolve) => {
      if (!s.recorder || s.recorder.state === "inactive") return resolve(null);
      s.recorder.onstop = () => resolve(new Blob(s.chunks, { type: s.recorder!.mimeType }));
      s.recorder.stop();
    });
    await s.ctx.close().catch(() => {});

    const finished = s.engine.finish();
    setData({ ...finished });
    setSummary(s.engine.summary());
    if (recorded) {
      const ext = recorded.type.includes("mp4") ? "m4a" : recorded.type.includes("ogg") ? "ogg" : "webm";
      setAudio({ url: URL.createObjectURL(recorded), name: `recording.${ext}`, blob: recorded });
    }
    session.current = null;
    stoppingRef.current = false;
    setMode("review");
    setZoom(0);
  }, []);

  const start = useCallback(
    async (file?: File) => {
      setError(null);
      if (!window.isSecureContext) {
        setError("Microphone access needs HTTPS (or localhost).");
        return;
      }
      if (audio) URL.revokeObjectURL(audio.url);
      setAudio(null);
      setData(null);
      setSummary(null);
      setMode("starting");

      // Create the context inside the click handler so browsers allow audio to start
      const ctx = new AudioContext({ latencyHint: "interactive" });
      try {
        await ctx.audioWorklet.addModule("/tap-worklet.js");
        let src: AudioNode;
        let stream: MediaStream | null = null;
        let fileEl: HTMLAudioElement | null = null;

        if (file) {
          fileEl = new Audio();
          const url = URL.createObjectURL(file);
          fileEl.src = url;
          src = ctx.createMediaElementSource(fileEl);
          src.connect(ctx.destination);
          setAudio({ url, name: file.name, blob: null });
          setSourceLabel(file.name);
        } else {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          });
          src = ctx.createMediaStreamSource(stream);
          setSourceLabel(stream.getAudioTracks()[0]?.label || "Microphone");
        }

        const tap = new AudioWorkletNode(ctx, "tap-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        const mute = ctx.createGain();
        mute.gain.value = 0;
        src.connect(tap);
        tap.connect(mute).connect(ctx.destination);

        const engine = new AnalysisEngine(ctx.sampleRate);
        engine.onBeat = flashBeat;
        tap.port.onmessage = (e: MessageEvent<Float32Array>) => engine.push(e.data);

        let recorder: MediaRecorder | null = null;
        const chunks: Blob[] = [];
        if (stream && typeof MediaRecorder !== "undefined") {
          const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((m) =>
            MediaRecorder.isTypeSupported(m),
          );
          recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
          recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          recorder.start(1000);
        }

        session.current = { ctx, tap, stream, recorder, chunks, fileEl, engine };
        await ctx.resume();
        if (fileEl) {
          fileEl.onended = () => void stop();
          fileEl.onpause = () => void stop();
          await fileEl.play();
        }
        setMode("recording");
      } catch (err) {
        await ctx.close().catch(() => {});
        setMode("idle");
        const msg = err instanceof Error ? err.message : String(err);
        setError(
          /denied|NotAllowed/i.test(msg)
            ? "Microphone permission was denied. Allow it in your browser's site settings and try again."
            : `Couldn't start audio: ${msg}`,
        );
      }
    },
    [audio, flashBeat, stop],
  );

  // Live loop: tiles at ~15 fps, timeline every frame, event list twice a second
  useEffect(() => {
    if (mode !== "recording") return;
    let lastSnap = 0;
    let lastList = 0;
    const loop = (now: number) => {
      const s = session.current;
      const canvas = canvasRef.current;
      const scroller = scrollRef.current;
      if (s && canvas && scroller) {
        const d = s.engine.data;
        const w = scroller.clientWidth;
        const g = sizeCanvas(canvas, w, TIMELINE_H);
        const tEnd = Math.max(LIVE_WINDOW, d.duration);
        drawTimeline(g, d, tEnd - LIVE_WINDOW, tEnd, w, readPalette(canvas));
        if (now - lastSnap > 66) {
          lastSnap = now;
          setSnap(snapshotFromEngine(s.engine));
        }
        if (now - lastList > 500) {
          lastList = now;
          setData(d);
          setVersion((v) => v + 1);
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mode]);

  // Warn before leaving mid-recording
  useEffect(() => {
    if (mode !== "recording") return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [mode]);

  // ---------------------------------------------------------------- review

  const pps = useMemo(() => {
    if (!data) return 1;
    const w = scrollRef.current?.clientWidth ?? 800;
    return zoom > 0 ? zoom : w / Math.max(1, data.duration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, zoom, version]);

  const drawReview = useCallback(() => {
    const canvas = canvasRef.current;
    if (mode !== "review" || !data || !canvas) return;
    const w = Math.max(1, Math.round(data.duration * pps));
    const g = sizeCanvas(canvas, w, TIMELINE_H);
    drawTimeline(g, data, 0, data.duration, w, readPalette(canvas));
  }, [mode, data, pps]);

  useEffect(() => {
    drawReview();
    const onResize = () => {
      setVersion((v) => v + 1);
    };
    window.addEventListener("resize", onResize);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", drawReview);
    return () => {
      window.removeEventListener("resize", onResize);
      mq.removeEventListener("change", drawReview);
    };
  }, [drawReview]);

  // Playback: move the playhead and replay the analysis in the tiles
  useEffect(() => {
    if (mode !== "review" || !data) return;
    const el = audioRef.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      const t = el.currentTime;
      const ph = playheadRef.current;
      const sc = scrollRef.current;
      if (ph) ph.style.transform = `translateX(${t * pps}px)`;
      if (sc && !el.paused) {
        const px = t * pps;
        if (px < sc.scrollLeft || px > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = px - 40;
      }
      setSnap(snapshotAt(data, t));
      const bi = data.beats.findIndex((b) => b > t) - 1;
      const lastBeat = bi >= 0 ? data.beats[bi] : data.beats.length && t >= data.beats.at(-1)! ? data.beats.at(-1)! : -1;
      if (!el.paused && lastBeat !== lastBeatShown.current && t - lastBeat < 0.1) flashBeat();
      lastBeatShown.current = lastBeat;
      if (!el.paused) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("seeked", tick);
    tick();
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("seeked", tick);
    };
  }, [mode, data, pps, audio, flashBeat]);

  const seek = (t: number) => {
    const el = audioRef.current;
    if (!el || !audio) {
      if (data) setSnap(snapshotAt(data, t));
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${t * pps}px)`;
      return;
    }
    el.currentTime = Math.max(0, t);
    if (el.paused) void el.play();
  };

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "review") return;
    const rect = e.currentTarget.getBoundingClientRect();
    seek((e.clientX - rect.left) / pps);
  };

  // ---------------------------------------------------------------- event list

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const out: Row[] = [];
    if (filters.has("section"))
      for (const s of data.sections) out.push({ t: s.t, end: s.end, type: "section", value: s.label, conf: null });
    if (filters.has("key"))
      for (const k of data.keys) out.push({ t: k.t, end: null, type: "key", value: k.key, conf: k.confidence });
    if (filters.has("chord"))
      for (const c of data.chords)
        out.push({ t: c.t, end: c.end, type: "chord", value: c.name === "N" ? "— (no chord)" : c.name, conf: c.confidence });
    if (filters.has("tempo")) {
      let last = -10;
      for (const p of data.tempo) {
        if (Math.abs(p.bpm - last) < 2) continue;
        last = p.bpm;
        out.push({ t: p.t, end: null, type: "tempo", value: `${Math.round(p.bpm)} BPM`, conf: p.confidence });
      }
    }
    if (filters.has("note"))
      for (const n of data.notes) out.push({ t: n.t, end: n.end, type: "note", value: `${n.note} (${n.hz} Hz)`, conf: null });
    if (filters.has("beat")) data.beats.forEach((b, i) => out.push({ t: b, end: null, type: "beat", value: `#${i + 1}`, conf: null }));
    out.sort((a, b) => a.t - b.t);
    return mode === "recording" ? out.reverse().slice(0, 300) : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, version, filters, mode]);

  const toggleFilter = (t: EventType) =>
    setFilters((f) => {
      const n = new Set(f);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  // ---------------------------------------------------------------- render

  const recording = mode === "recording";
  const canvasW = mode === "review" && data ? Math.max(1, Math.round(data.duration * pps)) : undefined;
  const tempoOk = snap.bpm > 0 && snap.tempoConfidence >= 0.15;
  const level = Math.min(1, Math.max(0, (snap.db + 60) / 60));

  return (
    <main className="wrap">
      <header className="head">
        <div>
          <h1>Live Music Analyzer</h1>
          <p className="sub">
            Chords, key, tempo, beats, pitch and song sections — tracked with timestamps, right in your browser.
          </p>
        </div>
      </header>

      <section className="card controls">
        {recording ? (
          <button className="btn rec on" onClick={() => void stop()}>
            <span className="sq" /> Stop
          </button>
        ) : (
          <button className="btn rec" onClick={() => void start()} disabled={mode === "starting"}>
            <span className="dot" /> {mode === "starting" ? "Starting…" : mode === "review" ? "Record again" : "Record"}
          </button>
        )}
        {!recording && (
          <label className="btn ghost">
            Analyze a file
            <input
              type="file"
              accept="audio/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void start(f);
              }}
            />
          </label>
        )}
        <div className="clock" aria-live="off">
          {recording && <span className="live-pill">LIVE</span>}
          <span className="mono">{fmtTime(recording ? snap.t : (data?.duration ?? 0))}</span>
          {sourceLabel && mode !== "idle" && <span className="src">{sourceLabel}</span>}
        </div>
      </section>

      {error && <div className="card error">{error}</div>}

      <section className="tiles">
        <div className="tile chord">
          <div className="k">Chord</div>
          <div className="v big">{snap.chord === "N" ? "—" : snap.chord}</div>
          <div className="s">{snap.chord !== "N" ? `since ${fmtTime(snap.chordSince)}` : "listening"}</div>
        </div>
        <div className="tile">
          <div className="k">Key</div>
          <div className="v">{snap.key ?? "—"}</div>
          <div className="s">{snap.key ? `${Math.round(snap.keyConfidence * 100)}% match` : "needs a few seconds"}</div>
        </div>
        <div className="tile">
          <div className="k">
            Tempo <span ref={beatDotRef} className="beat" />
          </div>
          <div className="v">{tempoOk ? Math.round(snap.bpm) : "—"}<small> BPM</small></div>
          <div className="s">{tempoOk ? `${Math.round(snap.tempoConfidence * 100)}% confident` : "finding the beat"}</div>
        </div>
        <div className="tile">
          <div className="k">Pitch</div>
          <div className="v">{snap.note ?? "—"}</div>
          <div className="tuner" aria-hidden>
            <span className="mid" />
            {snap.note && <span className="needle" style={{ left: `${50 + snap.cents}%` }} />}
          </div>
          <div className="s">{snap.note ? `${snap.hz.toFixed(1)} Hz · ${snap.cents > 0 ? "+" : ""}${snap.cents}¢` : "no clear pitch"}</div>
        </div>
        <div className="tile">
          <div className="k">Section</div>
          <div className="v">{snap.section}</div>
          <div className="s">same letter = sounds alike</div>
        </div>
        <div className="tile">
          <div className="k">Level</div>
          <div className="meter">
            <span style={{ width: `${level * 100}%` }} className={snap.db > -3 ? "hot" : ""} />
          </div>
          <div className="chroma-mini" aria-label="Pitch-class energy">
            {snap.chroma.map((v, i) => (
              <span key={i} title={NOTES[i]} style={{ height: `${8 + v * 28}px`, opacity: 0.25 + v * 0.75 }} />
            ))}
          </div>
          <div className="s mono">{snap.db > -119 ? `${snap.db.toFixed(0)} dBFS` : "—"}</div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Timeline</h2>
          {mode === "review" && data && (
            <label className="zoom">
              Zoom
              <input
                type="range"
                min={0}
                max={200}
                step={5}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
              />
              <span className="mono">{zoom === 0 ? "fit" : `${zoom}px/s`}</span>
            </label>
          )}
        </div>
        <div className="timeline">
          <div className="lane-labels" style={{ paddingTop: AXIS_H }}>
            {LANES.map((l) => (
              <div key={l.id} style={{ height: l.h, marginBottom: LANE_GAP }}>
                {l.label}
              </div>
            ))}
          </div>
          <div className="scroller" ref={scrollRef}>
            <div className="canvas-wrap" style={{ width: canvasW }}>
              <canvas ref={canvasRef} onClick={onCanvasClick} style={{ cursor: mode === "review" ? "pointer" : "default" }} />
              {mode === "review" && <div ref={playheadRef} className="playhead" />}
            </div>
            {mode === "idle" && <div className="empty">Press Record and play something. The timeline fills in as it listens.</div>}
          </div>
        </div>
        {mode === "review" && audio && (
          <audio ref={audioRef} src={audio.url} controls preload="auto" className="player" />
        )}
      </section>

      {mode === "review" && summary && data && (
        <section className="card summary">
          <h2>Summary</h2>
          <dl>
            <div><dt>Length</dt><dd className="mono">{fmtTime(summary.duration)}</dd></div>
            <div><dt>Tempo</dt><dd>{summary.bpm ? `${Math.round(summary.bpm)} BPM` : "—"}</dd></div>
            <div><dt>Key</dt><dd>{summary.key ?? "—"}</dd></div>
            <div><dt>Beats</dt><dd>{summary.beatCount}</dd></div>
            <div><dt>Form</dt><dd className="mono">{summary.form || "—"}</dd></div>
          </dl>
          {summary.chordsUsed.length > 0 && (
            <div className="chips">
              {summary.chordsUsed.slice(0, 12).map((c) => (
                <span key={c.name} className="chip static">
                  {c.name} <small>{c.seconds.toFixed(0)}s</small>
                </span>
              ))}
            </div>
          )}
          <div className="exports">
            <button className="btn ghost" onClick={() => download(`analysis-${stamp()}.json`, toJSON(data, summary), "application/json")}>
              JSON
            </button>
            <button className="btn ghost" onClick={() => download(`events-${stamp()}.csv`, toCSV(data), "text/csv")}>
              CSV
            </button>
            <button className="btn ghost" onClick={() => download(`labels-${stamp()}.txt`, toAudacityLabels(data))}>
              Audacity labels
            </button>
            {audio?.blob && (
              <button className="btn ghost" onClick={() => download(audio.name, audio.blob!)}>
                Audio
              </button>
            )}
          </div>
        </section>
      )}

      {data && (
        <section className="card">
          <div className="card-head">
            <h2>Events {recording && <small className="muted">newest first</small>}</h2>
            <div className="chips">
              {ALL_TYPES.map((t) => (
                <button key={t} className={`chip ${filters.has(t) ? "sel" : ""}`} onClick={() => toggleFilter(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Value</th>
                  <th className="num">Conf.</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.type}-${r.t}-${i}`} onClick={() => mode === "review" && seek(r.t)}>
                    <td className="mono">
                      {fmtTime(r.t)}
                      {r.end !== null && <span className="muted"> → {fmtTime(r.end)}</span>}
                    </td>
                    <td>
                      <span className={`tag ${r.type}`}>{r.type}</span>
                    </td>
                    <td>{r.value}</td>
                    <td className="num mono">{r.conf === null ? "" : `${Math.round(r.conf * 100)}%`}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={4} className="muted">
                      Nothing yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="foot">
        <p>
          Everything runs on your device — audio never leaves the browser. Chords and key are tuned for Western
          harmony at A440. Pitch follows the loudest single note, so it&apos;s most useful on solo voice or
          instruments. Sections appear ~10&nbsp;s after they start (back-dated to where they began).
        </p>
      </footer>
    </main>
  );
}
