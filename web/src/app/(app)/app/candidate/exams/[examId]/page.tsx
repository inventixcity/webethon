import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExamLobby } from "@/components/candidate/exam-lobby";
import { requireUser } from "@/features/auth/require-user";

export const metadata: Metadata = { title: "Exam lobby", robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = { params: Promise<{ examId: string }> };

export default async function ExamLobbyPage({ params }: Props) {
  await requireUser();
  const { examId } = await params;
  // Anything that isn't an id can't be an exam the candidate is enrolled in, so it gets the same 404.
  if (!UUID.test(examId)) notFound();

  return (
    <main className="mx-auto w-full max-w-4xl min-w-0 px-5 py-10 md:px-8 md:py-16">
      <ExamLobby examId={examId} />
    </main>
  );
}
