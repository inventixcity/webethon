import type { Metadata } from "next";
import { CertificateCheck } from "@/components/auth/certificate-check";

export const metadata: Metadata = { title: "Certificate check" };

export default async function CertificateVerificationPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <CertificateCheck code={code} />;
}
