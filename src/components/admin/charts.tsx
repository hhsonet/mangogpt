"use client";
import { useEffect, useId, useRef, useState } from "react";

export interface Series {
  name: string;
  color: string;
  values: (number | null)[];
}

const H = 150;
const PAD = { l: 40, r: 8, t: 8, b: 20 };
/** Left margin sized to the widest y-axis label so text is never clipped. */
const padLeft = (labels: string[]) => Math.max(34, Math.max(...labels.map((l) => l.length)) * 6 + 14);

/** Measures the container so charts draw at their real pixel width (text and lines stay crisp). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const spanLabel = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 5) return "now";
  if (s < 90) return `−${s}s`;
  if (s < 5400) return `−${Math.round(s / 60)} min`;
  if (s < 172800) return `−${Math.round(s / 3600)} h`;
  return `−${Math.round(s / 86400)} d`;
};

/** Friendly label for an hourly ("2026-10-02T18") or daily ("2026-10-02") bucket, in UTC. */
const bucketLabel = (b: string) => (b.length === 13 ? `${b.slice(5, 10)} ${b.slice(11)}:00 UTC` : b.slice(5));

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
}

/**
 * Responsive SVG time series. The first series is drawn as a filled area, the rest as lines.
 * Hovering shows the values at that point. `labels` gives the x-axis text for first/last points.
 */
export function TimeSeries({
  series,
  times,
  yMax,
  format = (v) => String(Math.round(v)),
  threshold,
  title,
}: {
  series: Series[];
  times: number[];
  yMax?: number;
  format?: (v: number) => string;
  threshold?: { value: number; label: string };
  title: string;
}) {
  const id = useId();
  const [boxRef, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = times.length;
  const max = yMax ?? niceMax(Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0))));
  const x = (i: number) => PADL + (n <= 1 ? 0 : (i / (n - 1)) * (W - PADL - PAD.r));
  const y = (v: number) => PAD.t + (1 - Math.min(v, max) / max) * (H - PAD.t - PAD.b);
  const ticks = [0, 0.5, 1].map((f) => f * max).filter((t, i, arr) => arr.findIndex((u) => format(u) === format(t)) === i);
  const PADL = padLeft(ticks.map(format));

  const path = (vals: (number | null)[]) =>
    vals.map((v, i) => (v === null ? "" : `${i === 0 || vals[i - 1] === null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join(" ");

  const first = series[0];
  const area = first && n > 1 ? `${path(first.values)} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : "";
  const ago = (t: number) => spanLabel(times[n - 1]! - t);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (n < 2) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - PADL) / (W - PADL - PAD.r)) * (n - 1)))));
  };

  return (
    <figure className="m-0" ref={boxRef}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="block max-w-full touch-none select-none"
        role="img"
        aria-label={`${title}. ${series.map((s) => `${s.name}: ${s.values[n - 1] === null || s.values[n - 1] === undefined ? "no data" : format(s.values[n - 1]!)}`).join(", ")}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={first?.color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={first?.color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PADL} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
            <text x={PADL - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">
              {format(t)}
            </text>
          </g>
        ))}
        {threshold && (
          <g>
            <line x1={PADL} x2={W - PAD.r} y1={y(threshold.value)} y2={y(threshold.value)} stroke="var(--warn)" strokeDasharray="4 4" strokeWidth="1" />
            <text x={W - PAD.r} y={y(threshold.value) - 3} textAnchor="end" fontSize="10" fill="var(--warn)">
              {threshold.label}
            </text>
          </g>
        )}
        {area && <path d={area} fill={`url(#${id}-fill)`} />}
        {series.map((s) => (
          <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {n > 1 && (
          <>
            <text x={PADL} y={H - 5} fontSize="10" fill="var(--muted)">
              {ago(times[0]!)}
            </text>
            <text x={W - PAD.r} y={H - 5} fontSize="10" textAnchor="end" fill="var(--muted)">
              now
            </text>
          </>
        )}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeWidth="1" strokeDasharray="2 3" />
            {series.map((s) => s.values[hover] !== null && s.values[hover] !== undefined && <circle key={s.name} cx={x(hover)} cy={y(s.values[hover]!)} r="3.5" fill={s.color} stroke="var(--bg)" strokeWidth="1.5" />)}
          </g>
        )}
      </svg>
      <figcaption className="mt-1 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.name}
            {hover !== null && s.values[hover] !== null && s.values[hover] !== undefined && <strong className="font-medium text-fg">{format(s.values[hover]!)}</strong>}
          </span>
        ))}
        {hover !== null && <span className="ml-auto">{ago(times[hover]!)}</span>}
      </figcaption>
    </figure>
  );
}

/** Stacked bars (up to two series) for per-hour or per-day counts. */
export function Bars({ labels, a, b, aLabel, bLabel, title }: { labels: string[]; a: number[]; b: number[]; aLabel: string; bLabel: string; title: string }) {
  const [boxRef, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const n = labels.length;
  const max = niceMax(Math.max(1, ...a.map((v, i) => v + (b[i] ?? 0))));
  const PADL = padLeft([String(Math.round(max))]);
  const bw = (W - PADL - PAD.r) / Math.max(n, 1);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const total = a.reduce((s, v) => s + v, 0) + b.reduce((s, v) => s + v, 0);
  return (
    <figure className="m-0" ref={boxRef}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="img" aria-label={`${title}. ${total} requests in total.`} onPointerLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PADL} x2={W - PAD.r} y1={y(f * max)} y2={y(f * max)} stroke="var(--border)" />
            <text x={PADL - 6} y={y(f * max) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">
              {Math.round(f * max)}
            </text>
          </g>
        ))}
        {labels.map((l, i) => {
          const x0 = PADL + i * bw + bw * 0.15;
          const w = Math.max(1.5, bw * 0.7);
          return (
            <g key={l} onPointerEnter={() => setHover(i)}>
              <rect x={PADL + i * bw} y={PAD.t} width={bw} height={H - PAD.t - PAD.b} fill="transparent" />
              {(a[i] ?? 0) > 0 && <rect x={x0} y={y(a[i]!)} width={w} height={y(0) - y(a[i]!)} rx="1.5" fill="var(--accent)" opacity={hover === null || hover === i ? 1 : 0.5} />}
              {(b[i] ?? 0) > 0 && <rect x={x0} y={y(a[i]! + b[i]!)} width={w} height={y(a[i]!) - y(a[i]! + b[i]!)} rx="1.5" fill="var(--chart-2)" opacity={hover === null || hover === i ? 1 : 0.5} />}
            </g>
          );
        })}
        {n > 0 && (
          <>
            <text x={PADL} y={H - 5} fontSize="10" fill="var(--muted)">
              {bucketLabel(labels[0]!)}
            </text>
            <text x={W - PAD.r} y={H - 5} fontSize="10" textAnchor="end" fill="var(--muted)">
              {bucketLabel(labels[n - 1]!)}
            </text>
          </>
        )}
      </svg>
      <figcaption className="mt-1 flex min-h-5 flex-wrap items-center gap-x-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-accent" />{aLabel}</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--chart-2)" }} />{bLabel}</span>
        {hover !== null && (
          <span className="ml-auto text-fg">
            {bucketLabel(labels[hover]!)} · {a[hover]} chats · {b[hover]} images
          </span>
        )}
      </figcaption>
    </figure>
  );
}
