"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { UserPreferences } from "@/lib/exam/types";

export type ExamDefaults = NonNullable<UserPreferences["examiner"]>["examDefaults"];

/** Examiner settings for pre-filling a new exam form. The consumer still validates its own form. */
export function useExamDefaults() {
  const [defaults, setDefaults] = useState<ExamDefaults>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    api<{ prefs: UserPreferences }>("/me/preferences")
      .then(({ prefs }) => { if (active) setDefaults(prefs.examiner?.examDefaults); })
      .catch(() => { if (active) setDefaults(undefined); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return { defaults, loading };
}
