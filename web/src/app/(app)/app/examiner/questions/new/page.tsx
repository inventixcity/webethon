import type { Metadata } from "next";
import { QuestionEditor } from "@/components/questions/question-editor";

export const metadata: Metadata = { title: "New question", robots: { index: false, follow: false } };

export default function NewQuestionPage() {
  return <QuestionEditor />;
}
