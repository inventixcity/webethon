import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ResultView } from "@/components/candidate/result-view";
import { requireUser } from "@/features/auth/require-user";

export const metadata: Metadata = { title: "Your result", robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = { params: Promise<{ attemptId: string }> };

export default async function ResultPage({ params }: Props) {
  await requireUser();
  const { attemptId } = await params;
  if (!UUID.test(attemptId)) notFound();

  return (
    <main className="mx-auto w-full max-w-5xl min-w-0 px-5 py-10 md:px-8 md:py-16">
      <ResultView attemptId={attemptId} />
    </main>
  );
}
