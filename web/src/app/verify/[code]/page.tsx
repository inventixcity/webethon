import type { Metadata } from "next";
import { CertificateCheck } from "@/components/auth/certificate-check";
import { Art, hasArt } from "@/components/ui/art";

export const metadata: Metadata = { title: "Certificate check" };

export default async function CertificateVerificationPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <CertificateCheck
      key={code}
      code={code}
      background={
        hasArt("verify-bg") ? <Art name="verify-bg" alt="" sizes="100vw" className="size-full" /> : null
      }
    />
  );
}
