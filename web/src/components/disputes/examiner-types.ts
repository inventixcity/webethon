import type { Dispute, QuestionKind, QuestionOption } from "@/lib/exam/types";

/**
 * What the examiner queue needs on top of the shared Dispute. The queue endpoint sends these; each one is optional so
 * the screens still work while the backend is catching up. The UI names what is missing rather than guessing.
 */
export type ExaminerDispute = Dispute & {
  kind?: QuestionKind;
  /** The question's full mark value, the ceiling for a regrade. */
  itemMarks?: number;
  /** The marks the script got for this question now. */
  awardedMarks?: number;
  /** Options for an objective question, for accepting alternatives. */
  options?: QuestionOption[];
  /** Who resolved it, for the audit line. */
  resolvedBy?: string | null;
};
