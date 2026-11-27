"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { ExamMonitor, ExamTimeseries } from "@/lib/exam/types";

const palette = ["text-ink", "text-cobalt", "text-amber", "text-cobalt-deep"] as const;
const series = [
  { key: "answersSaved", label: "Answers saved", color: "var(--color-ink)" },
  { key: "activeCandidates", label: "Active candidates", color: "var(--color-cobalt)" },
  { key: "connectionDrops", label: "Connection drops", color: "var(--color-amber)" },
  { key: "submissions", label: "Submissions", color: "var(--color-cobalt-deep)" },
] as const;

export function ActivityCharts({ examId, snapshot }: { examId: string; snapshot: ExamMonitor }) {
  const [data, setData] = useState<ExamTimeseries | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => api<ExamTimeseries>(`/exams/${encodeURIComponent(examId)}/stats/timeseries?bucket=60`).then((value) => {
      if (live) { setData(value); setError(false); }
    }).catch(() => { if (live) setError(true); });
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [examId]);
  const points = data?.buckets ?? [];
  const values = points.flatMap((point) => series.map(({ key }) => point[key]));
  const max = Math.max(1, ...values);
  const x = (index: number) => points.length < 2 ? 20 : 20 + index * 360 / (points.length - 1);
  const y = (value: number) => 150 - value / max * 125;
  const chartPath = (key: typeof series[number]["key"]) => points.map((point, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(point[key])}`).join(" ");
  const statusTotal = snapshot.enrolled || 1;
  const statuses = [
    { label: "Not started", value: snapshot.notStarted, color: "bg-ink-muted" },
    { label: "In progress", value: snapshot.inProgress, color: "bg-cobalt" },
    { label: "Submitted", value: snapshot.submitted, color: "bg-amber" },
  ];
  return <section className="grid gap-6 border border-rule bg-paper-raised p-4 md:grid-cols-2 md:p-5" aria-label="Live exam charts">
    <figure className="min-w-0" aria-labelledby="exam-activity-title">
      <figcaption id="exam-activity-title" className="mb-3 font-mono text-[11px] tracking-[0.12em] uppercase">Activity · per minute</figcaption>
      {!data || points.length === 0 ? <p role={error ? "status" : undefined} className="grid min-h-40 place-items-center text-sm text-ink-muted">{error ? "Activity data could not be refreshed." : "Waiting for activity in this exam window."}</p> : <>
        <svg viewBox="0 0 400 170" className="h-auto w-full overflow-visible text-ink" role="group" aria-labelledby="exam-activity-svg-title exam-activity-svg-desc">
          <title id="exam-activity-svg-title">Exam activity per minute</title>
          <desc id="exam-activity-svg-desc">Lines show answers saved, active candidates, connection drops and submissions for each minute bucket.</desc>
          {[0, 1, 2, 3].map((step) => <g key={step}><line x1="20" x2="380" y1={20 + step * 40} y2={20 + step * 40} stroke="currentColor" opacity="0.15"/><text x="0" y={24 + step * 40} className="fill-ink-muted font-mono text-[9px]">{Math.round(max * (1 - step / 3))}</text></g>)}
          {series.map(({ key, label, color }) => <path key={key} d={chartPath(key)} fill="none" stroke={color} strokeWidth="2" className="transition-[d] duration-300 motion-reduce:transition-none"><title>{label}</title></path>)}
          {points.map((point, index) => <circle key={point.at} cx={x(index)} cy={y(point.answersSaved)} r="3" fill="var(--color-ink)" tabIndex={0} role="img" aria-label={`${new Date(point.at).toLocaleTimeString()}: ${point.answersSaved} answers, ${point.activeCandidates} active, ${point.connectionDrops} drops, ${point.submissions} submissions`}><title>{new Date(point.at).toLocaleTimeString()}: {point.answersSaved} saved, {point.activeCandidates} active, {point.connectionDrops} drops, {point.submissions} submitted</title></circle>)}
        </svg>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 font-mono text-[10px] text-ink-muted">{series.map((item, index) => <li key={item.key} className="flex items-center gap-1.5"><span aria-hidden="true" className={`size-2 ${palette[index]}`} style={{ backgroundColor: item.color }} />{item.label}</li>)}</ul>
        <table className="sr-only"><caption>Activity counts by minute</caption><thead><tr><th>Time</th>{series.map((item) => <th key={item.key}>{item.label}</th>)}</tr></thead><tbody>{points.map((point) => <tr key={point.at}><th>{new Date(point.at).toLocaleString()}</th>{series.map((item) => <td key={item.key}>{point[item.key]}</td>)}</tr>)}</tbody></table>
      </>}
    </figure>
    <figure className="min-w-0" aria-labelledby="exam-status-title">
      <figcaption id="exam-status-title" className="mb-3 font-mono text-[11px] tracking-[0.12em] uppercase">Candidate status</figcaption>
      <div role="img" aria-label={statuses.map((item) => `${item.label}: ${item.value}`).join(", ")} className="flex h-8 w-full border border-rule">
        {statuses.map((item) => <span key={item.label} title={`${item.label}: ${item.value}`} tabIndex={0} role="img" aria-label={`${item.label}: ${item.value}`} className={`${item.color} transition-[width] duration-300 motion-reduce:transition-none`} style={{ width: `${item.value / statusTotal * 100}%` }} />)}
      </div>
      <ul className="mt-4 grid gap-2">{statuses.map((item) => <li key={item.label} className="flex items-center justify-between gap-3 border-b border-rule py-2 text-sm"><span className="flex items-center gap-2"><span aria-hidden="true" className={`size-2 ${item.color}`} />{item.label}</span><span className="font-mono tabular-nums">{item.value}</span></li>)}</ul>
      <table className="sr-only"><caption>Candidate status counts</caption><tbody>{statuses.map((item) => <tr key={item.label}><th>{item.label}</th><td>{item.value}</td></tr>)}</tbody></table>
    </figure>
  </section>;
}
