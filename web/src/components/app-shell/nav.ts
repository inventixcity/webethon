import { ClipboardList, GraduationCap, LayoutDashboard, Library, ScrollText, Server, Settings, Users, Inbox, LifeBuoy, type LucideIcon } from "lucide-react";
import { EXAM_TABS } from "@/components/exams/exam-tabs";

export type NavItem = { href: string; label: string; icon: LucideIcon; exact?: boolean };
export type NavGroup = { label: string; items: NavItem[] };

/** A breadcrumb. An exam crumb is named by the shell from the live exam, so the title never goes stale. */
export type Crumb = { label: string; href?: string } | { examId: string; href: string };

const EXAMINER: NavGroup = {
  label: "Run exams",
  items: [
    { href: "/app/examiner", label: "Overview", icon: LayoutDashboard, exact: true },
    { href: "/app/examiner/exams", label: "Exams", icon: ClipboardList },
    { href: "/app/examiner/questions", label: "Question bank", icon: Library },
  ],
};

const CANDIDATE: NavGroup = {
  label: "Take exams",
  items: [{ href: "/app/candidate", label: "My exams", icon: GraduationCap, exact: true }],
};

const ADMIN: NavGroup = {
  label: "Administration",
  items: [
    { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
    { href: "/admin/users", label: "Users", icon: Users },
    { href: "/admin/requests", label: "Requests", icon: Inbox },
    { href: "/admin/audit", label: "Audit", icon: ScrollText },
    { href: "/admin/system", label: "System", icon: Server },
  ],
};

export const SETTINGS_ITEM: NavItem = { href: "/app/settings", label: "Settings", icon: Settings };
const SUPPORT: NavGroup = { label: "Help", items: [{ href: "/contact", label: "Contact support", icon: LifeBuoy }] };

export const ROLE_LABEL: Record<string, string> = { candidate: "Candidate", examiner: "Examiner", admin: "Admin" };

/** The groups each role sees. The server decides what each role may do; this only decides what is shown. */
export function navGroupsFor(role: string): NavGroup[] {
  if (role === "candidate") return [CANDIDATE, SUPPORT];
  if (role === "examiner") return [EXAMINER, SUPPORT];
  // An admin can also open every exam, so the examiner area sits beside the admin area.
  if (role === "admin") return [ADMIN, EXAMINER, SUPPORT];
  return [];
}

/** The page a role lands on from the logo. */
export function homeFor(role: string): string {
  if (role === "admin") return "/admin";
  if (role === "examiner") return "/app/examiner";
  return "/app/candidate";
}

export function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

const ADMIN_PAGES: Record<string, string> = { users: "Users", requests: "Requests", audit: "Audit", system: "System" };

/** The trail shown in the top bar, from the path. Dynamic exam segments become exam crumbs the shell names. */
export function crumbsFor(pathname: string): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  const root = parts[0];

  if (root === "admin") {
    const page = ADMIN_PAGES[parts[1] ?? ""];
    return page
      ? [{ label: "Admin", href: "/admin" }, { label: page }]
      : [{ label: "Admin", href: "/admin" }, { label: "Overview" }];
  }

  if (root !== "app") return [];
  const section = parts[1];

  if (section === "settings") return [{ label: "Settings" }];

  if (section === "candidate") {
    const trail: Crumb[] = [{ label: "Candidate", href: "/app/candidate" }];
    if (parts.length === 2) return [...trail, { label: "My exams" }];
    if (parts[2] === "exams") return [...trail, { label: "Exam lobby" }];
    if (parts[2] === "results") return [...trail, { label: "Result" }];
    return trail;
  }

  if (section === "examiner") {
    const home: Crumb = { label: "Examiner", href: "/app/examiner" };
    if (parts.length === 2) return [home, { label: "Overview" }];
    const area = parts[2];

    if (area === "exams") {
      const trail: Crumb[] = [home, { label: "Exams", href: "/app/examiner/exams" }];
      if (parts.length === 3) return [...trail];
      if (parts[3] === "new") return [...trail, { label: "New exam" }];
      const examHref = `/app/examiner/exams/${parts[3]}`;
      const examId = decodeURIComponent(parts[3]);
      if (parts.length === 4) return [...trail, { examId, href: examHref }];
      const tab = EXAM_TABS.find((item) => item.slug === parts[4]);
      return [...trail, { examId, href: examHref }, { label: tab?.label ?? "Page" }];
    }

    if (area === "questions") {
      const trail: Crumb[] = [home, { label: "Question bank", href: "/app/examiner/questions" }];
      if (parts.length === 3) return trail;
      if (parts[3] === "new") return [...trail, { label: "New question" }];
      if (parts[3] === "import") return [...trail, { label: "Import" }];
      return [...trail, { label: "Edit question" }];
    }
    return [home];
  }

  return [];
}

