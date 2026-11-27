/** The signed-in person's profile, as returned by GET and PATCH /api/v1/me. */
export type Profile = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  createdAt: string;
};

/** One signed-in device, as returned by GET /api/v1/auth/sessions. */
export type Session = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string;
  userAgent: string;
  /** True for the session making the request, which can't be revoked from this list. */
  current: boolean;
};
