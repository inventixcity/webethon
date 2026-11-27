import { GridPulse } from "./shape-loaders";

/** Fills the screen while a route loads. */
export function PageLoader({ label = "Loading" }: { label?: string }) {
  return (
    <main className="grid min-h-dvh place-items-center">
      <div className="grid justify-items-center gap-5">
        <GridPulse size={48} label={label} />
        <p className="font-mono text-[11px] tracking-[0.14em] uppercase">{label}</p>
      </div>
    </main>
  );
}
