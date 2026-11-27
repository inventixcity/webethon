/**
 * The Invigil API contract, shared by every screen. The Rust crates return exactly these shapes inside the
 * `{ data: ... }` envelope (the `api()` helper in `@/lib/api/client` unwraps it). camelCase everywhere.
 * Timestamps are RFC 3339 strings in UTC. Marks are numbers rounded to 2 dp.
 *
 * Changing a type here is a contract change: note it in handoff/HANDOFF.md (Contract changes) first.
 */

export type Role = "admin" | "examiner" | "candidate";
export type QuestionKind = "single" | "multi" | "written";
export type MultiRule = "all_or_nothing" | "partial" | "partial_penalty";
/** Stored status. */
export type ExamStatus = "draft" | "published" | "completed" | "archived";
/** Derived from status + window + server clock. */
export type ExamPhase = "draft" | "scheduled" | "ongoing" | "closed" | "completed" | "archived";
export type AttemptStatus = "in_progress" | "submitted" | "expired";
export type GradingStatus = "pending" | "partial" | "complete";
export type ReviewPriority = "none" | "low" | "medium" | "high";

export type Page<T> = { items: T[]; nextCursor: string | null };

// ------------------------------------------------------------------ question bank (examiner)
export type QuestionOption = { id: string; text: string };

export type Question = {
  id: string;
  topic: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  kind: QuestionKind;
  stem: string;
  options: QuestionOption[];
  /** Answer key (option ids). Examiner endpoints only. */
  correct: string[];
  marks: number;
  negativeMarks: number;
  multiRule: MultiRule;
  rubric: string;
  maxWords: number | null;
  explanation: string;
  /** Observed facility index 0..1 from real attempts (null until enough data). */
  observedFacility: number | null;
  observedCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type QuestionInput = Omit<Question, "id" | "observedFacility" | "observedCount" | "version" | "createdAt" | "updatedAt">;

export type ImportRowError = { row: number; path: string; message: string };
export type ImportResult = { dryRun: boolean; created: number; updated: number; errors: ImportRowError[] };

// ------------------------------------------------------------------ exams (examiner)
export type ExamSettings = {
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  /** 5.3: allow answering while offline (journal synced on reconnect). */
  allowOfflineJournal: boolean;
  /** Minutes after startsAt a candidate may still start. null = any time in the window. */
  lateJoinMinutes: number | null;
  /** Show per-question breakdown with results. */
  showBreakdown: boolean;
  integrity: {
    /** 5.1: invisible per-candidate watermark in question text, traceable if leaked. */
    watermark: boolean;
    /** 5.1: hidden AI canary instruction; flagged if it appears in a written answer. */
    canary: boolean;
    /** Ask for fullscreen and record exits. */
    fullscreen: boolean;
  };
};

export type ExamSummary = {
  id: string;
  title: string;
  status: ExamStatus;
  phase: ExamPhase;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  totalMarks: number;
  questionCount: number;
  enrolledCount: number;
  attemptCount: number;
  resultsPublishedAt: string | null;
  updatedAt: string;
};

export type Exam = ExamSummary & {
  instructions: string;
  passMarks: number;
  settings: ExamSettings;
  version: number;
  /** Assigned bank questions in order (draft) or the frozen paper (published). Includes keys: examiner only. */
  questions: Array<{ questionId: string | null; position: number; marks: number; question: Question }>;
};

export type ExamInput = {
  title: string;
  instructions: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  totalMarks: number;
  passMarks: number;
  settings: ExamSettings;
};

/** GET /exams/{id}/review: the pre-publication checklist. */
export type ExamReview = {
  ready: boolean;
  checks: Array<{ key: string; ok: boolean; message: string }>;
  marksAssigned: number;
  topicMix: Array<{ topic: string; count: number; marks: number }>;
  difficultyMix: Array<{ difficulty: number; count: number }>;
};

// ------------------------------------------------------------------ enrollment (examiner)
export type Enrollment = {
  candidateId: string;
  email: string;
  displayName: string;
  status: "enrolled" | "revoked";
  extraMinutes: number;
  invited: boolean;
  /** Account has set a password. */
  activated: boolean;
  attempt: { id: string; status: AttemptStatus; totalScore: number | null } | null;
  createdAt: string;
};

/** POST /exams/{id}/enrollments response: import result plus one-time invite links (owner only). */
export type EnrollResult = ImportResult & { inviteLinks: Array<{ email: string; url: string }> };

export type CandidateImportRow = { email: string; displayName: string; extraMinutes?: number };

// ------------------------------------------------------------------ candidate views
export type CandidateExamCard = {
  examId: string;
  title: string;
  phase: ExamPhase;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  totalMarks: number;
  /** What the candidate can do now. */
  access: "upcoming" | "available" | "in_progress" | "submitted" | "missed" | "results";
  attemptId: string | null;
  resultsPublished: boolean;
};

export type CandidateDashboard = {
  serverNow: string;
  available: CandidateExamCard[];
  upcoming: CandidateExamCard[];
  completed: CandidateExamCard[];
};

export type ExamLobby = CandidateExamCard & {
  instructions: string;
  questionCount: number;
  extraMinutes: number;
  settings: Pick<ExamSettings, "allowOfflineJournal" | "integrity">;
  /** Can a new attempt be started right now (server decides). */
  canStart: boolean;
  reason: string | null;
};

// ------------------------------------------------------------------ attempt workspace (candidate or sandbox)
/** Never contains answer keys, rubric or explanations. */
export type AttemptItem = {
  id: string;
  position: number;
  kind: QuestionKind;
  /** May contain an invisible per-attempt watermark (zero-width chars). Render as plain text. */
  stem: string;
  /** Already in this attempt's shuffled display order. */
  options: QuestionOption[];
  marks: number;
  negativeMarks: number;
  multiRule: MultiRule;
  maxWords: number | null;
  topic: string;
};

export type AnswerResponse = { selected: string[] } | { text: string };

export type SavedAnswer = {
  itemId: string;
  response: AnswerResponse;
  flagged: boolean;
  clientSeq: number;
  savedAt: string;
};

/** 5.3: a server-signed proof the attempt was alive at issuedAt (server ms). */
export type Lease = { attemptId: string; issuedAt: number; deadlineAt: number; mac: string };

export type Announcement = { id: string; body: string; createdAt: string };

export type AttemptPayload = {
  id: string;
  examId: string;
  examTitle: string;
  instructions: string;
  sandbox: boolean;
  status: AttemptStatus;
  startedAt: string;
  /** Authoritative deadline (includes accommodations and audited time credits). */
  deadlineAt: string;
  /** Server clock at response time; the client keeps an offset, never trusts its own clock. */
  serverNow: string;
  totalMarks: number;
  items: AttemptItem[];
  answers: SavedAnswer[];
  /** 5.3 offline journal: base64url genesis hash and current server head/seq. */
  journal: { genesis: string; head: string | null; seq: number; enabled: boolean };
  lease: Lease;
  /** Device lock: whether this device (X-Attempt-Device) holds the attempt. */
  deviceActive: boolean;
  announcements: Announcement[];
  settings: Pick<ExamSettings, "allowOfflineJournal" | "integrity">;
  /** Hidden AI canary text to embed visually-hidden in stems when integrity.canary is on (null otherwise). */
  canary: string | null;
};

/** PUT /attempts/{id}/answers/{itemId} */
export type SaveAnswerInput = {
  response: AnswerResponse;
  flagged: boolean;
  clientSeq: number;
  /** Written answers only: counts, never content. */
  typing?: { keystrokes: number; pastes: number; pastedChars: number; activeMs: number };
};
export type SaveAnswerResult = { itemId: string; clientSeq: number; savedAt: string; accepted: boolean };

/** POST /attempts/{id}/heartbeat */
export type HeartbeatInput = { online: boolean; pending: number; lastAnnouncementAt: string | null };
export type HeartbeatResult = {
  serverNow: string;
  deadlineAt: string;
  status: AttemptStatus;
  lease: Lease;
  deviceActive: boolean;
  announcements: Announcement[];
};

/** One offline answer in the hash-chained journal (5.3). */
export type JournalEntry = {
  seq: number;
  itemId: string;
  response: AnswerResponse;
  flagged: boolean;
  /** The lease held when written, and monotonic ms elapsed since it was received. */
  lease: Lease;
  elapsedMs: number;
  /** = lease.issuedAt + elapsedMs */
  writtenAt: number;
  /** base64url SHA-256 chain hash (see examcore::chain_next / journal.ts). */
  hash: string;
};
export type JournalSyncResult = {
  accepted: number[];
  rejected: Array<{ seq: number; reason: "chain" | "lease" | "late" | "future" | "stale" | "closed" }>;
  head: string | null;
  seq: number;
};

/** POST /attempts/{id}/events (batched, max 50) */
export type IntegrityEventKind =
  | "focus_lost" | "visibility_hidden" | "fullscreen_exit" | "paste" | "copy" | "context_menu"
  | "typing_anomaly" | "offline" | "online" | "announcement_seen";
export type IntegrityEventInput = {
  kind: IntegrityEventKind;
  /** Client time is informational only. */
  clientAt: string;
  durationMs?: number;
  detail?: Record<string, string | number | boolean>;
};

export type WorkspacePrefs = {
  fontScale: 0.9 | 1 | 1.15 | 1.3;
  /** "single" = one question per screen; "scroll" = all questions in one column. */
  layout: "single" | "scroll";
  paletteSide: "left" | "right";
  contrast: "normal" | "high";
  /** Override of the site theme inside the workspace. */
  theme: "system" | "light" | "dark";
  timerStyle: "countdown" | "hidden_until_5min";
  lineSpacing: "normal" | "relaxed";
};

export type Scratch = { text: string; sketch: string | null; updatedAt: string | null };

// ------------------------------------------------------------------ monitoring (examiner)
export type MonitorRow = {
  attemptId: string;
  candidateId: string;
  displayName: string;
  email: string;
  status: AttemptStatus;
  startedAt: string;
  deadlineAt: string;
  answered: number;
  flagged: number;
  total: number;
  lastHeartbeatAt: string | null;
  online: boolean;
  incidents: number;
  reviewPriority: ReviewPriority;
  sandbox: false;
};
export type ExamMonitor = {
  serverNow: string;
  phase: ExamPhase;
  enrolled: number;
  notStarted: number;
  inProgress: number;
  submitted: number;
  rows: MonitorRow[];
  announcements: Announcement[];
};

export type AttemptEvent = {
  id: number;
  kind: string;
  severity: "info" | "notice" | "warning";
  detail: Record<string, unknown>;
  durationMs: number | null;
  clientAt: string | null;
  recordedAt: string;
};

export type IntegrityReport = {
  attemptId: string;
  reviewPriority: ReviewPriority;
  /** Plain-language indicators. Always shown with the disclaimer: indicators are not evidence. */
  indicators: Array<{ key: string; label: string; weight: number; count: number; explanation: string }>;
  events: AttemptEvent[];
  outages: Outage[];
  /** Always shown: "Indicators support human review. They are not evidence of misconduct." */
  disclaimer: string;
};

/** 5.3: a server-verified connectivity gap (from heartbeats). */
export type Outage = { from: string; to: string; seconds: number; credited: boolean };

// ------------------------------------------------------------------ grading and results (examiner)
export type GradingItem = {
  attemptId: string;
  itemId: string;
  /** Blind grading: candidate identity hidden by default; label like "Script 07". */
  scriptLabel: string;
  position: number;
  stem: string;
  rubric: string;
  marks: number;
  answerText: string;
  wordCount: number;
  manualMarks: number | null;
  feedback: string;
  gradedAt: string | null;
};

export type ResultRow = {
  attemptId: string;
  candidateId: string;
  displayName: string;
  email: string;
  status: AttemptStatus;
  autoScore: number | null;
  manualScore: number | null;
  totalScore: number | null;
  percent: number | null;
  passed: boolean | null;
  gradingStatus: GradingStatus;
  reviewPriority: ReviewPriority;
  submittedAt: string | null;
};
export type ExamResults = {
  examId: string;
  totalMarks: number;
  passMarks: number;
  resultsPublishedAt: string | null;
  /** Publishing needs every real attempt finalized and fully graded. */
  canPublish: boolean;
  blockers: string[];
  rows: ResultRow[];
};

// ------------------------------------------------------------------ candidate result
export type CandidateResult = {
  attemptId: string;
  examTitle: string;
  totalMarks: number;
  passMarks: number;
  totalScore: number;
  percent: number;
  passed: boolean;
  submittedAt: string | null;
  publishedAt: string;
  verifyCode: string;
  breakdown: Array<{
    /** The exam item, so a candidate can dispute this question (5.4). */
    itemId: string;
    /** True when the question was voided after a dispute: it no longer counts for anyone. */
    voided?: boolean;
    position: number;
    kind: QuestionKind;
    stem: string;
    marks: number;
    awarded: number;
    response: AnswerResponse | null;
    correct: string[] | null;
    options: QuestionOption[];
    feedback: string;
    explanation: string;
  }> | null;
};

/** Public: GET /verify/{code}. Minimal, masked facts only. */
export type VerificationResult = {
  valid: boolean;
  revoked: boolean;
  statement: {
    certificateId: string;
    examTitle: string;
    /** e.g. "A. K****n" */
    candidate: string;
    percent: number;
    passed: boolean;
    issuedAt: string;
    issuer: string;
  } | null;
  signature: { algorithm: "Ed25519"; keyId: string; valid: boolean } | null;
};

// ------------------------------------------------------------------ analytics (examiner)
export type ExamAnalytics = {
  examId: string;
  attempts: number;
  submitted: number;
  mean: number;
  median: number;
  stdDev: number;
  highest: number;
  lowest: number;
  passRate: number;
  /** 10 buckets of percent 0-10 ... 90-100 */
  histogram: Array<{ from: number; to: number; count: number }>;
  /** Reliability (KR-20 style) when computable. */
  reliability: number | null;
  items: ItemAnalytics[];
  topics: Array<{ topic: string; meanPercent: number; items: number }>;
  /** 5.1: candidate pairs with unusually many identical wrong answers (indicator only). */
  similarPairs: Array<{ a: string; b: string; identicalWrong: number; ratio: number }>;
};

export type ItemAnalytics = {
  itemId: string;
  position: number;
  kind: QuestionKind;
  stem: string;
  topic: string;
  declaredDifficulty: number;
  /** Facility (p-value): mean awarded / marks, 0..1. Higher = easier. */
  facility: number | null;
  /** Upper-lower 27% discrimination, -1..1. */
  discrimination: number | null;
  skipRate: number;
  attempts: number;
  /** Option distribution for objective items (distractor analysis). */
  options: Array<{ id: string; text: string; correct: boolean; picks: number }>;
  flags: Array<"too_easy" | "too_hard" | "negative_discrimination" | "often_skipped" | "dead_distractor">;
};

// ------------------------------------------------------------------ admin
export type AdminUser = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: "active" | "suspended";
  createdAt: string;
};

// ================================================================== PHASE 2 (27 Nov afternoon)

// ------------------------------------------------------------------ 5.2 fair randomised papers
/** One blueprint row: draw `count` questions of this topic within a difficulty band from the exam's pool. */
export type BlueprintRow = { topic: string; minDifficulty: number; maxDifficulty: number; count: number; marksEach: number };
export type Blueprint = {
  enabled: boolean;
  rows: BlueprintRow[];
  /** Allowed spread of predicted difficulty between any two papers (0..1 on the facility scale). */
  tolerance: number;
};
/** GET /exams/{id}/blueprint/preview: simulated papers before publish. */
export type BlueprintPreview = {
  feasible: boolean;
  problems: string[];
  poolSize: number;
  paperSize: number;
  totalMarks: number;
  /** Predicted mean facility per simulated paper (higher = easier), for 50 simulated candidates. */
  simulated: number[];
  spread: number;
  fairnessScore: number;
};
/** GET /exams/{id}/fairness: after attempts exist. */
export type FairnessReport = {
  papers: number;
  meanPredicted: number;
  spread: number;
  /** 0..100: 100 = every candidate got an equally difficult paper. */
  fairnessScore: number;
  rows: Array<{ attemptId: string; candidate: string; predictedFacility: number; observedPercent: number | null }>;
};

// ------------------------------------------------------------------ 5.4 disputes
export type DisputeStatus = "open" | "accepted" | "rejected";
export type DisputeResolution = "none" | "regrade" | "void_item" | "accept_alternative";
export type Dispute = {
  id: string;
  attemptId: string;
  itemId: string;
  position: number;
  stem: string;
  /** Candidate's reason, 10–2000 chars. */
  reason: string;
  status: DisputeStatus;
  resolution: DisputeResolution;
  response: string;
  createdAt: string;
  resolvedAt: string | null;
  /** Examiner view only. Blind by default: "Script 07". */
  scriptLabel?: string;
  /** Score before and after resolution, when it changed. */
  scoreBefore: number | null;
  scoreAfter: number | null;
  /** Examiner view: the question's marks, the marks currently awarded, its kind and options (for accept-alternative). */
  itemMarks?: number;
  awardedMarks?: number | null;
  kind?: QuestionKind;
  options?: QuestionOption[];
  /** Display name of the examiner who resolved it (examiner view and audit line). */
  resolvedBy?: string | null;
};

// ------------------------------------------------------------------ AI grading assistant (optional)
export type GradingSuggestion = {
  suggestedMarks: number;
  maxMarks: number;
  /** Short rationale tied to rubric points. */
  rationale: string;
  rubricHits: string[];
  model: string;
};

// ------------------------------------------------------------------ live room
/** Server-sent event payload on GET /exams/{id}/monitor/stream (event: "snapshot"). */
export type MonitorSnapshotEvent = ExamMonitor;
/** POST /exams/{id}/outage-credit result. */
export type BulkCreditResult = { credited: number; skipped: number; secondsTotal: number };

// ------------------------------------------------------------------ STATS
/** GET /exams/{id}/stats/timeseries: buckets are UTC RFC 3339 timestamps. */
export type ExamTimeseriesBucket = {
  at: string;
  answersSaved: number;
  activeCandidates: number;
  connectionDrops: number;
  submissions: number;
};
export type ExamTimeseries = {
  examId: string;
  bucketSeconds: number;
  from: string;
  to: string;
  buckets: ExamTimeseriesBucket[];
};
/** GET /examiner/stats. */
export type ExaminerStats = {
  submissionsPerDay: Array<{ day: string; count: number }>;
  passRateByExam: Array<{ examId: string; title: string; completedAt: string; passRate: number; submissions: number }>;
  candidatesNow: number;
};
/** GET /admin-stats/overview. */
export type AdminStatsOverview = {
  signInsPerHour: Array<{ at: string; count: number }>;
  activeSessions: number;
  accountsByRole: Array<{ role: "candidate" | "examiner" | "admin"; count: number }>;
  examsByPhase: Array<{ phase: ExamPhase; count: number }>;
};

// ------------------------------------------------------------------ SETTINGS
export type SettingsRole = "candidate" | "examiner" | "admin";
export type UserPreferences = {
  theme: "system" | "light" | "dark";
  reducedMotion: boolean;
  textSize: "sm" | "md" | "lg";
  timeZone: string;
  emailNotifications: { securityAlerts: true; productUpdates: boolean };
  candidate?: { accessibility: { highContrast: boolean; dyslexiaFont: boolean; largerTargets: boolean; confirmBeforeSubmit: boolean }; examReminders: { emailBeforeStartMinutes: 0 | 15 | 60 | 1440 } };
  examiner?: { examDefaults: { durationMinutes: number; passPercent: number; shuffleQuestions: boolean; shuffleOptions: boolean; lateJoinMinutes: number; integrity: { fullscreen: boolean; pasteBlock: boolean; focusTracking: boolean; typingTelemetry: boolean } }; notifications: { onSubmissionsComplete: boolean; onDisputeFiled: boolean; onOutageReported: boolean } };
  admin?: { notifications: { onInstituteRequest: boolean; onSecurityEvent: boolean } };
};
export type InstitutionSettings = { name: string; shortName: string; contactEmail: string; supportHours: string; defaultTimeZone: string; aiSuggestionsEnabled: boolean; allowCandidateSelfDelete: boolean; staffMfaRequired: boolean; resultsVerificationPublic: boolean };
