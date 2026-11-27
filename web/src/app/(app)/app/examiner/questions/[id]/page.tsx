import type { Metadata } from "next";
import { connection } from "next/server";
import { QuestionEditor } from "@/components/questions/question-editor";

export const metadata: Metadata = { title: "Edit question", robots: { index: false, follow: false } };

/** Edits one question. The editor loads it through the API, which answers 404 for anyone who does not own it. */
export default async function EditQuestionPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  return <QuestionEditor questionId={id} />;
}
