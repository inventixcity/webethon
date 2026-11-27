import { redirect } from "next/navigation";

// Opens on the review index for now. Point this at the real home page once it exists.
export default function HomePage() {
  redirect("/kit");
}
