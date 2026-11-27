import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { createElement } from "react";
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { signedVisitorHeaders } from "@/lib/api/forward";

export const runtime = "nodejs";

const styles = StyleSheet.create({ page: { padding: 38, fontFamily: "Helvetica", color: "#12110E", fontSize: 9 }, rule: { height: 2, backgroundColor: "#D23A1C", marginBottom: 20 }, title: { fontSize: 20, marginBottom: 18 }, heading: { fontSize: 12, marginTop: 18, marginBottom: 8 }, row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#B9B3A7", paddingVertical: 5 }, cell: { flex: 1 }, label: { fontFamily: "Courier", fontSize: 8, color: "#6B6759" } });

export async function GET(_request: Request, context: { params: Promise<{ examId: string }> }) {
  const { examId } = await context.params;
  const incoming = await headers();
  const origin = process.env.API_ORIGIN?.replace(/\/+$/, "");
  if (!origin) return NextResponse.json({ error: { code: "UNAVAILABLE", message: "Report service is unavailable." } }, { status: 503, headers: { "cache-control": "no-store" } });
  let upstream: Response;
  try {
    upstream = await fetch(`${origin}/api/v1/exams/${encodeURIComponent(examId)}/report`, { headers: { accept: "application/json", cookie: incoming.get("cookie") ?? "", "x-request-id": crypto.randomUUID(), ...signedVisitorHeaders(incoming) }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
  } catch {
    return NextResponse.json({ error: { code: "UNAVAILABLE", message: "Report service is unavailable." } }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!upstream.ok) return NextResponse.json(await upstream.json().catch(() => ({ error: { code: "UPSTREAM_ERROR", message: "The report could not be loaded." } })), { status: upstream.status, headers: { "cache-control": "no-store" } });
  const payload = await upstream.json() as { data: { summary: { count: number; mean: number; median: number; highest: number; lowest: number; passRate: number }; distribution: Array<{ from: number; to: number; count: number }>; rows: Array<{ displayName: string; totalScore: number | null; percent: number | null; passed: boolean | null }>; itemSummary: Array<{ position: number; stem: string; facility: number; responses: number }> } };
  const { summary, distribution, rows, itemSummary } = payload.data;
  const document = createElement(Document, null, createElement(Page, { size: "A4", style: styles.page },
    createElement(View, { style: styles.rule }), createElement(Text, { style: styles.title }, "Inventix Invigil · Exam report"),
    createElement(Text, { style: styles.label }, `ATTEMPTS ${summary.count}     MEAN ${summary.mean}     MEDIAN ${summary.median}     HIGH ${summary.highest}     LOW ${summary.lowest}     PASS ${summary.passRate}%`),
    createElement(Text, { style: styles.heading }, "SCORE DISTRIBUTION"),
    createElement(View, null, ...distribution.map((bucket) => createElement(View, { key: String(bucket.from), style: styles.row }, createElement(Text, { style: styles.cell }, `${bucket.from}–${bucket.to}%`), createElement(Text, { style: styles.cell }, `${bucket.count} candidates`)))),
    createElement(Text, { style: styles.heading }, "RESULTS"),
    createElement(View, null, ...rows.map((row, index) => createElement(View, { key: String(index), style: styles.row }, createElement(Text, { style: styles.cell }, row.displayName), createElement(Text, { style: styles.cell }, row.totalScore == null ? "—" : `${row.totalScore} · ${row.percent}%`), createElement(Text, { style: styles.cell }, row.passed == null ? "PENDING" : row.passed ? "PASS" : "FAIL")))),
    createElement(Text, { style: styles.heading }, "ITEM FACILITY"),
    createElement(View, null, ...itemSummary.map(item => createElement(View, { key: String(item.position), style: styles.row }, createElement(Text, { style: styles.cell }, `${String(item.position).padStart(2, "0")}  ${item.stem}`), createElement(Text, { style: styles.cell }, `${item.facility} · ${item.responses} responses`))))));
  const pdf = await renderToBuffer(document);
  return new NextResponse(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="invigil-exam-${examId}.pdf"`, "cache-control": "no-store" } });
}
