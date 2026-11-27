import { redirect } from "next/navigation";

/** Accounts are provisioned by an institution (admin or examiner invites), so self-signup is closed. */
export default function SignupPage() {
  redirect("/login");
}
