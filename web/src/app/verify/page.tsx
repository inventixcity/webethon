import type { Metadata } from "next";
import { CertificateCheck } from "@/components/auth/certificate-check";
import { Art, hasArt } from "@/components/ui/art";

export const metadata: Metadata = { title: "Verify a result" };

export default function VerifyPage() {
  return (
    <CertificateCheck
      background={
        hasArt("verify-bg") ? <Art name="verify-bg" alt="" sizes="100vw" className="size-full" /> : null
      }
    />
  );
}
