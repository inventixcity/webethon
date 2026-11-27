import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { createElement } from "react";
import { Image, Text, View, renderToBuffer } from "@react-pdf/renderer";
import QRCode from "qrcode";
import { signedVisitorHeaders } from "@/lib/api/forward";
import { brandPage, pdfDocument, pdfStyles as s } from "@/lib/pdf/report";
import { safeSlug, pdfDisposition } from "@/lib/pdf/names";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await context.params; const incoming = await headers(); const origin = process.env.API_ORIGIN?.replace(/\/+$/, "");
  if (!origin) return NextResponse.json({ error: { code: "UNAVAILABLE", message: "Report service is unavailable." } }, { status: 503, headers: { "cache-control": "no-store" } });
  let upstream: Response;
  try { upstream = await fetch(`${origin}/api/v1/attempts/${encodeURIComponent(attemptId)}/report`, { headers: { accept: "application/json", cookie: incoming.get("cookie") ?? "", "x-request-id": crypto.randomUUID(), ...signedVisitorHeaders(incoming) }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) }); }
  catch { return NextResponse.json({ error: { code: "UNAVAILABLE", message: "Report service is unavailable." } }, { status: 503, headers: { "cache-control": "no-store" } }); }
  if (!upstream.ok) return NextResponse.json(await upstream.json().catch(() => ({ error: { code: "UPSTREAM_ERROR", message: "The report could not be loaded." } })), { status: upstream.status, headers: { "cache-control": "no-store" } });
  const payload = await upstream.json() as { data: { candidate: string; examTitle: string; date: string | null; score: number; totalMarks: number; percent: number; passed: boolean; items: Array<{ position: number; stem: string; marks: number; awarded: number; feedback: string }>; verifyCode: string; verifyUrl: string } };
  const d = payload.data; const qr = await QRCode.toDataURL(d.verifyUrl, { width: 240, margin: 1, errorCorrectionLevel: "M" });
  const rows = (d.items ?? []).map(item => createElement(View, { key: String(item.position), style: { ...s.row, backgroundColor: item.position % 2 ? "#F5F1E7" : "#EAE6DB" }, wrap: false },
    createElement(Text, { style: { width: 28, fontFamily: "Courier-Bold" } }, String(item.position).padStart(2, "0")),
    createElement(View, { style: { flex: 1 } }, createElement(Text, null, item.stem || "Question"), createElement(View, { style: { ...s.barTrack, marginTop: 4 } }, createElement(View, { style: { ...s.bar, width: `${item.marks > 0 ? Math.max(0, Math.min(100, item.awarded / item.marks * 100)) : 0}%` } }))),
    createElement(Text, { style: { width: 56, textAlign: "right" } }, `${item.awarded} / ${item.marks}`)));
  const page = brandPage(createElement(View, null,
    createElement(Text, { style: s.eyebrow }, "OFFICIAL RESULT STATEMENT"), createElement(Text, { style: s.title }, d.examTitle),
    createElement(Text, { style: s.muted }, `${d.candidate}  ·  ${d.date ? new Date(d.date).toLocaleDateString("en-PK", { dateStyle: "long", timeZone: "Asia/Karachi" }) : "Date not recorded"}`),
    createElement(View, { style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 22, padding: 14, borderTopWidth: 2, borderTopColor: "#244FC4", backgroundColor: "#E9E5DA" } }, createElement(View, null, createElement(Text, { style: s.score }, `${d.percent}%`), createElement(Text, { style: s.label }, `${d.score} OF ${d.totalMarks} MARKS`)), createElement(Text, { style: s.stamp }, d.passed ? "PASS" : "NOT PASSED")),
    createElement(Text, { style: s.section }, "QUESTION BREAKDOWN"), createElement(View, null, ...rows),
    createElement(View, { style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 16 } }, createElement(View, { style: s.box }, createElement(Text, { style: s.label }, "VERIFY CODE"), createElement(Text, { style: { fontFamily: "Courier-Bold", fontSize: 12, marginTop: 6 } }, d.verifyCode), createElement(Text, { style: { ...s.small, marginTop: 6 } }, d.verifyUrl)), createElement(Image, { src: qr, style: { width: 78, height: 78 } })),
    createElement(View, { style: { flexDirection: "row", justifyContent: "space-between" } }, createElement(View, { style: s.sign }, createElement(Text, { style: s.label }, "AUTHORIZED SIGNATURE")), createElement(View, { style: { ...s.sign, width: 90 } }, createElement(Text, { style: s.label }, "INSTITUTE SEAL")))) , d.verifyUrl);
  const pdf = await renderToBuffer(pdfDocument(page)); const filename = `${safeSlug(d.examTitle)}_${safeSlug(d.candidate)}_result.pdf`;
  return new NextResponse(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": pdfDisposition(filename), "cache-control": "no-store" } });
}
