import { ErrorPage } from "@/components/errors/error-page";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "404 · Uncharted waters" };

export default function NotFound() {
  return <ErrorPage code={404} />;
}
