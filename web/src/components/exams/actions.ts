import { api } from "@/lib/api/client";
import type { Exam } from "@/lib/exam/types";

/** Creates a sandbox attempt on this exam's paper (4.3) and returns its id. The caller opens /exam/{id}. */
export async function createSandboxAttempt(examId: string): Promise<string> {
  const result = await api<{ attemptId: string }>(`/exams/${encodeURIComponent(examId)}/sandbox`, { method: "POST" });
  return result.attemptId;
}

export function duplicateExam(examId: string): Promise<Exam> {
  return api<Exam>(`/exams/${encodeURIComponent(examId)}/duplicate`, { method: "POST" });
}

export function publishExam(examId: string): Promise<Exam> {
  return api<Exam>(`/exams/${encodeURIComponent(examId)}/publish`, { method: "POST" });
}

export function unpublishExam(examId: string): Promise<Exam> {
  return api<Exam>(`/exams/${encodeURIComponent(examId)}/unpublish`, { method: "POST" });
}

/** `force` completes an exam whose window is still open. The server requires it for that case. */
export function completeExam(examId: string, force: boolean): Promise<Exam> {
  const query = force ? "?force=true" : "";
  return api<Exam>(`/exams/${encodeURIComponent(examId)}/complete${query}`, { method: "POST" });
}
