/** Team roles, from most to least access. The API orders them the same way. */
export const TEAM_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** Invites and direct role changes can't grant ownership, so ownership is only ever handed over. */
export type AssignableRole = Exclude<TeamRole, "owner">;

export const ROLE_LABEL: Record<TeamRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

export const ROLE_HELP: Record<TeamRole, string> = {
  owner: "Runs the team. Can delete it or hand it over.",
  admin: "Manages people, roles and invites.",
  member: "Works in the team.",
  viewer: "Can look, but can't change anything.",
};

const RANK: Record<TeamRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function isAtLeast(role: TeamRole, minimum: TeamRole): boolean {
  return RANK[role] >= RANK[minimum];
}

/** The roles someone with `role` may hand out. Mirrors the API, so the UI never offers a refused choice. */
export function assignableRoles(role: TeamRole): AssignableRole[] {
  return (["admin", "member", "viewer"] as const).filter((candidate) => RANK[candidate] <= RANK[role]);
}

export type Team = {
  id: string;
  name: string;
  slug: string;
  /** The signed-in person's own role on this team. */
  role: TeamRole;
  createdAt: string;
  memberCount: number;
};

export type Member = {
  userId: string;
  displayName: string;
  /** Only present for admins and owners. */
  email?: string;
  role: TeamRole;
  joinedAt: string;
};

export type Invite = {
  id: string;
  email: string;
  role: AssignableRole;
  createdAt: string;
  expiresAt: string;
};
