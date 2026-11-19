import { ReactNode, useId, useState } from 'react';

/** Dependency-free SVG/CSS charts in the dashboard style: smooth lines with soft area fills, rounded stacked bars, tooltips. */

export interface LineSeries { name: string; color: string; points: number[] }

/** Smooth path through the points (Catmull-Rom converted to cubic Béziers). */
function smooth(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]; const p1 = pts[i]; const p2 = pts[i + 1]; const p3 = pts[i + 2] ?? p2;
    // control points stay between the neighbouring values vertically, so the curve never dips below zero or overshoots a peak
    const lo = Math.min(p1[1], p2[1]); const hi = Math.max(p1[1], p2[1]);
    const cl = (v: number) => Math.max(lo, Math.min(hi, v));
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${cl(p1[1] + (p2[1] - p0[1]) / 6)} ${p2[0] - (p3[0] - p1[0]) / 6},${cl(p2[1] - (p3[1] - p1[1]) / 6)} ${p2[0]},${p2[1]}`;
  }
  return d;
}

export function LineChart({ labels, series, height = 220, empty = 'No data in this period yet.' }: { labels: string[]; series: LineSeries[]; height?: number; empty?: ReactNode }) {
  const uid = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const W = 640; const padL = 34; const padR = 12; const padT = 14; const padB = 26;
  const max = Math.max(1, ...series.flatMap((s) => s.points));
  const niceMax = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
  const x = (i: number) => padL + (labels.length <= 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (labels.length - 1));
  const y = (v: number) => padT + (1 - v / niceMax) * (height - padT - padB);
  if (!labels.length || series.every((s) => s.points.every((v) => v === 0))) return <div className="empty">{empty}</div>;
  const every = Math.max(1, Math.ceil(labels.length / 7));
  const showLabel = (i: number) => i === labels.length - 1 || (i % every === 0 && labels.length - 1 - i >= every);
  return (
    <div className="chart" style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label={`Line chart: ${series.map((s) => s.name).join(', ')}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(labels.length - 1, Math.round(((px - padL) / (W - padL - padR)) * (labels.length - 1)))));
        }}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.name} id={`${uid}g${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity=".28" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {[0, 1, 2, 3, 4].map((g) => {
          const v = (niceMax / 4) * g;
          return (
            <g key={g}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity=".09" strokeDasharray="3 4" />
              <text x={padL - 8} y={y(v) + 4} textAnchor="end" fontSize="10.5" fill="currentColor" fillOpacity=".55">{Math.round(v)}</text>
            </g>
          );
        })}
        {labels.map((l, i) => showLabel(i) && <text key={l + i} x={x(i)} y={height - 6} textAnchor="middle" fontSize="10.5" fill="currentColor" fillOpacity=".55">{l}</text>)}
        {series.map((s, i) => {
          const pts = s.points.map((v, k) => [x(k), y(v)] as [number, number]);
          const line = smooth(pts);
          return (
            <g key={s.name}>
              <path d={`${line} L${x(labels.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={`url(#${uid}g${i})`} className="chart-fade" />
              <path d={line} fill="none" stroke={s.color} strokeWidth="2.6" strokeLinecap="round" pathLength={1} className="chart-line" />
            </g>
          );
        })}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={height - padB} stroke="currentColor" strokeOpacity=".25" />
            {series.map((s) => <circle key={s.name} cx={x(hover)} cy={y(s.points[hover])} r="4.5" fill="var(--surface-2)" stroke={s.color} strokeWidth="2.5" />)}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <b>{labels[hover]}</b>
          {series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}: {s.points[hover]}</span>)}
        </div>
      )}
      <div className="row" style={{ gap: 16, marginTop: 6 }}>
        {series.map((s) => <span key={s.name} className="hint"><i className="dot" style={{ background: s.color }} />{s.name}</span>)}
      </div>
    </div>
  );
}

export interface BarRow { name: string; a: number; b: number }

/** Horizontal stacked bars (two values per row); the caller sorts the rows. */
export function StackedBars({ rows, aLabel, bLabel, aColor, bColor, empty = 'No data in this period yet.' }: { rows: BarRow[]; aLabel: string; bLabel: string; aColor: string; bColor: string; empty?: ReactNode }) {
  const max = Math.max(1, ...rows.map((r) => r.a + r.b));
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <div className="bars" role="img" aria-label={rows.map((r) => `${r.name}: ${aLabel} ${r.a}, ${bLabel} ${r.b}`).join('; ')}>
      {rows.map((r) => (
        <div className="bar-row" key={r.name} title={`${r.name}: ${aLabel} ${r.a}, ${bLabel} ${r.b}`}>
          <div className="bar-head"><span>{r.name}</span><span className="hint">{r.a + r.b}</span></div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(r.a / max) * 100}%`, background: aColor }} />
            <div className="bar-fill" style={{ width: `${(r.b / max) * 100}%`, background: bColor }} />
          </div>
        </div>
      ))}
      <div className="row" style={{ gap: 16 }}>
        <span className="hint"><i className="dot" style={{ background: aColor }} />{aLabel}</span>
        <span className="hint"><i className="dot" style={{ background: bColor }} />{bLabel}</span>
      </div>
    </div>
  );
}
