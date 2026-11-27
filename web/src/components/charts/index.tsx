"use client";
import { useState } from "react";

export type ChartDatum = { key: string | number | boolean | null; value: number | null };
export type ChartProps = { data: ChartDatum[] | null | undefined; label: string; formatKey?: (key: ChartDatum["key"]) => string; formatValue?: (value: number) => string; className?: string };
const keyText = (key: ChartDatum["key"]) => key === null ? "None" : String(key);
const valueText = (value: number) => Number.isFinite(value) ? value.toLocaleString() : "Unavailable";
function Chart({ data, label, formatKey = keyText, formatValue = valueText, className = "", kind }: ChartProps & { kind: "bar" | "line" | "donut" }) {
  const [focused, setFocused] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const active = focused ?? hovered;
  const valid = (data ?? []).map(d => ({ ...d, value: typeof d.value === "number" && Number.isFinite(d.value) ? d.value : null }));
  const shownValue = (value: number | null) => value === null ? "Unavailable" : formatValue(value);
  const numeric = valid.flatMap(d => d.value === null ? [] : [d.value]);
  const min = Math.min(0, ...numeric);
  const max = Math.max(0, ...numeric);
  const span = max - min || 1;
  const y = (v: number) => 170 - (v - min) / span * 140;
  const x = (i: number) => 25 + (i + 0.5) * 350 / Math.max(valid.length, 1);
  const positiveTotal = valid.reduce((s, d) => s + Math.max(0, d.value ?? 0), 0);
  const displayKind = kind === "donut" && (positiveTotal === 0 || valid.some(d => d.value === null || d.value < 0)) ? "bar" : kind;
  let offset = 0;
  const marks = valid.map((d, i) => {
    const name = `${formatKey(d.key)}: ${shownValue(d.value)}`;
    const events = { tabIndex: 0, role: "img" as const, "aria-label": name, onFocus: () => setFocused(i), onBlur: () => setFocused(null), onPointerEnter: () => setHovered(i), onPointerLeave: () => setHovered(null) };
    if (displayKind === "donut") {
      const fraction = positiveTotal ? Math.max(0, d.value ?? 0) / positiveTotal : 0;
      const start = offset; offset += fraction;
      return <circle key={i} cx="200" cy="100" r="65" fill="none" stroke="currentColor" strokeWidth="25" strokeDasharray={`${fraction * 408.4} ${408.4}`} strokeDashoffset={-start * 408.4} transform="rotate(-90 200 100)" opacity={0.35 + 0.65 * ((i % 4) + 1) / 4} {...events}><title>{name}</title></circle>;
    }
    if (displayKind === "line") return <circle key={i} cx={x(i)} cy={y(d.value ?? 0)} r="5" fill={d.value === null ? "none" : "currentColor"} stroke="currentColor" {...events}><title>{name}</title></circle>;
    const baseline = y(0); const top = y(d.value ?? 0);
    return <rect key={i} x={x(i) - Math.min(14, 150 / valid.length)} y={Math.min(top, baseline) - (d.value === 0 ? 1 : 0)} width={Math.min(28, 300 / valid.length)} height={Math.max(2, Math.abs(baseline - top))} fill={d.value === null ? "none" : "currentColor"} stroke={d.value === null ? "currentColor" : "none"} {...events}><title>{name}</title></rect>;
  });
  return <figure className={className}><figcaption className="mb-3 text-sm font-medium">{label}</figcaption>{kind === "donut" && displayKind === "bar" && valid.length > 0 && <p className="text-xs text-ink-muted">Shown as bars because these values cannot form a positive share.</p>}{valid.length ? <><svg viewBox="0 0 400 200" className="h-auto w-full text-ink" aria-label={label} role="group">{displayKind !== "donut" && <line x1="20" x2="380" y1={y(0)} y2={y(0)} stroke="currentColor" opacity="0.3" />}{displayKind === "line" && valid.slice(1).map((d, i) => d.value !== null && valid[i].value !== null ? <line key={i} x1={x(i)} y1={y(valid[i].value!)} x2={x(i + 1)} y2={y(d.value)} stroke="currentColor" strokeWidth="2" /> : null)}{displayKind === "donut" && <circle cx="200" cy="100" r="65" fill="none" stroke="currentColor" opacity="0.1" strokeWidth="25" />}{marks}</svg><p className="min-h-6 font-mono text-xs text-ink-soft" aria-live="polite">{active === null || !valid[active] ? "Focus or point to a value" : `${formatKey(valid[active].key)}: ${shownValue(valid[active].value)}`}</p></> : <p className="py-8 text-sm text-ink-muted">No data for this period.</p>}<table className="sr-only"><caption>{label}</caption><thead><tr><th scope="col">Group</th><th scope="col">Value</th></tr></thead><tbody>{(data ?? []).map((d, i) => <tr key={i}><th scope="row">{formatKey(d.key)}</th><td>{shownValue(typeof d.value === "number" && Number.isFinite(d.value) ? d.value : null)}</td></tr>)}</tbody></table></figure>;
}
export function BarChart(props: ChartProps) { return <Chart {...props} kind="bar" />; }
export function LineChart(props: ChartProps) { return <Chart {...props} kind="line" />; }
export function DonutChart(props: ChartProps) { return <Chart {...props} kind="donut" />; }
export function Sparkline(props: ChartProps) { return <Chart {...props} kind="line" />; }
export function StatTile({ label, value, className = "" }: { label: string; value: string | number; className?: string }) { return <div className={`border-t border-rule py-5 ${className}`}><dt className="font-mono text-xs text-ink-muted">{label}</dt><dd className="mt-2 text-3xl font-medium">{value}</dd></div>; }
