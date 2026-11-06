import { useState } from 'react';

export interface Slice {
  label: string;
  value: number;
  color: string;
}

const SIZE = 148;
const STROKE = 24;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP = 2;

/**
 * Pie-style ring with its figures beside it. Every value is written in the
 * legend, so nothing depends on colour or hovering alone.
 */
export function Donut({ title, slices, unit, empty, format = (n) => n.toLocaleString() }: {
  title: string;
  slices: Slice[];
  unit: string;
  empty: string;
  format?: (n: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = slices.filter((s) => s.value > 0);
  const total = shown.reduce((n, s) => n + s.value, 0);
  const pct = (v: number) => {
    const p = (v / total) * 100;
    return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
  };

  if (!total) {
    return (
      <div className="card chart">
        <h3>{title}</h3>
        <div className="chart-empty">{empty}</div>
      </div>
    );
  }

  let start = 0;
  const arcs = shown.map((s) => {
    const length = (s.value / total) * CIRCUMFERENCE;
    const arc = { ...s, length, offset: start };
    start += length;
    return arc;
  });
  const centre = format(total);
  const active = hover === null ? null : shown[hover];

  return (
    <div className="card chart">
      <h3>{title}</h3>
      {active && <div className="chart-tip" role="status">{active.label}: {format(active.value)} ({pct(active.value)})</div>}
      <div className="chart-body">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={`${title}: ${shown.map((s) => `${s.label} ${format(s.value)}`).join(', ')}`}
          onMouseLeave={() => setHover(null)}
        >
          <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
            {arcs.map((a, i) => (
              <circle
                key={a.label}
                className={`ring ${hover !== null && hover !== i ? 'dim' : ''}`}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={a.color}
                strokeWidth={STROKE}
                strokeDasharray={`${Math.max(a.length - (arcs.length > 1 ? GAP : 0), 0.5)} ${CIRCUMFERENCE}`}
                strokeDashoffset={-a.offset}
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </g>
          <text x="50%" y="48%" textAnchor="middle" className="chart-center-value" style={centre.length > 8 ? { fontSize: 13 } : undefined}>{centre}</text>
          <text x="50%" y="60%" textAnchor="middle" className="chart-center-label">{unit}</text>
        </svg>
        <ul className="chart-legend">
          {shown.map((s, i) => (
            <li key={s.label} className={hover === i ? 'on' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
              <span>{s.label}</span>
              <span className="val">{format(s.value)}<span className="pct">{pct(s.value)}</span></span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
