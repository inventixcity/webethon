import type { Metadata } from "next";
import { Art } from "@/components/ui/art";
import { DriftField } from "@/components/ui/empty-state";
import { InviteForm } from "./invite-form";

export const metadata: Metadata = { title: "Accept invitation" };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const side = (
    <Art
      name="invite-side"
      alt=""
      sizes="(min-width: 1024px) 30vw, 0px"
      className="h-full min-h-full w-full"
      fallback={<DriftField className="size-full" />}
    />
  );
  return <InviteForm token={token} side={side} />;
}
