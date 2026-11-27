import { PanelLoading } from "@/components/candidate/notice";

export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-16 md:px-8">
      <PanelLoading label="Loading the lobby" />
    </main>
  );
}
