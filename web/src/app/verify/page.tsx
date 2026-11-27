import type { Metadata } from "next";
import { CertificateCheck } from "@/components/auth/certificate-check";

export const metadata: Metadata = { title: "Verify a result" };

export default function VerifyPage() {
  return <CertificateCheck />;
}
