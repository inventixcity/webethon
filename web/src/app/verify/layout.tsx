import { VerifyTopBar } from "@/components/verify/verify-top-bar";

export default function VerifyLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-paper text-ink">
      <VerifyTopBar />
      {children}
    </div>
  );
}
