import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { createElement } from "react";
import { Document, Page, Image, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import QRCode from "qrcode";
import { signedVisitorHeaders } from "@/lib/api/forward";

export const runtime = "nodejs";

const styles = StyleSheet.create({ page: { padding: 42, fontFamily: "Helvetica", color: "#12110E", fontSize: 10 }, rule: { height: 2, backgroundColor: "#D23A1C", marginBottom: 24 }, title: { fontSize: 21, marginBottom: 18 }, label: { fontFamily: "Courier", fontSize: 8, marginTop: 14, color: "#6B6759" }, value: { fontSize: 12, marginTop: 4 }, table: { marginTop: 18 }, row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#B9B3A7", paddingVertical: 7 }, cell: { flex: 1 }, small: { fontSize: 8 }, qr: { width: 92, height: 92, marginTop: 24 } });

export async function GET(_request: Request, context: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await context.params;
  const incoming = await headers();
  const origin = process.env.API_ORIGIN?.replace(/\/+$/, "");
  if (!origin) return NextResponse.json({ error: { code: "UNAVAILABLE", message: "Report service is unavailable." } }, { status: 503 });
  let upstream: Response;
  try {
    upstream = await fetch(`${origin}/api/v1/attempts/${encodeURIComponent(attemptId)}/report`, { headers: { accept: "application/json", cookie: incoming.get("cookie") ?? "", "x-request-id": crypto.randomUUID(), ...signedVisitorHeaders(incoming) }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
  } catch {
    return NextResponse.json({ error: { code: "UNAVAILABLE", message: "Report service is unavailable." } }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!upstream.ok) return NextResponse.json(await upstream.json().catch(() => ({ error: { code: "UPSTREAM_ERROR", message: "The report could not be loaded." } })), { status: upstream.status, headers: { "cache-control": "no-store" } });
  const payload = await upstream.json() as { data: { candidate: string; examTitle: string; date: string | null; score: number; totalMarks: number; percent: number; passed: boolean; items: Array<{ position: number; stem: string; marks: number; awarded: number; feedback: string }>; verifyCode: string; verifyUrl: string } };
  const data = payload.data;
  const qr = await QRCode.toDataURL(data.verifyUrl, { width: 300, margin: 1, errorCorrectionLevel: "M" });
  const document = createElement(Document, null, createElement(Page, { size: "A4", style: styles.page },
    createElement(View, { style: styles.rule }), createElement(Text, { style: styles.title }, "Inventix Invigil · Result statement"),
    createElement(Text, { style: styles.label }, "CANDIDATE"), createElement(Text, { style: styles.value }, data.candidate),
    createElement(Text, { style: styles.label }, "EXAM"), createElement(Text, { style: styles.value }, data.examTitle),
    createElement(Text, { style: styles.label }, "ISSUED"), createElement(Text, { style: styles.value }, data.date ?? "—"),
    createElement(Text, { style: styles.label }, "RESULT"), createElement(Text, { style: styles.value }, `${data.score} / ${data.totalMarks} · ${data.percent}% · ${data.passed ? "PASS" : "FAIL"}`),
    createElement(View, { style: styles.table }, ...data.items.map(item => createElement(View, { key: String(item.position), style: styles.row }, createElement(Text, { style: styles.cell }, `${String(item.position).padStart(2, "0")}  ${item.stem}`), createElement(Text, { style: styles.small }, `${item.awarded} / ${item.marks}`)))),
    createElement(Image, { src: qr, style: styles.qr }), createElement(Text, { style: styles.small }, `Verification code  ${data.verifyCode}`)));
  const pdf = await renderToBuffer(document);
  return new NextResponse(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="invigil-attempt-${attemptId}.pdf"`, "cache-control": "no-store" } });
}
