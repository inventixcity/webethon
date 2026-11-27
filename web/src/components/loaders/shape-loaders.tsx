import { cn } from "@/lib/utils";
import styles from "./loaders.module.css";

type LoaderProps = {
  /** Spoken to screen readers, and never shown. */
  label?: string;
  className?: string;
};

/** Marks a decorative animation as a single status for screen readers. */
function Status({
  label = "Loading",
  className,
  style,
  children,
}: LoaderProps & { style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <div role="status" aria-label={label} className={className} style={style}>
      {children}
    </div>
  );
}

/** A block running round the edge of a square. */
export function SquareOrbit({ size = 40, ...props }: LoaderProps & { size?: number }) {
  return (
    <Status
      {...props}
      className={cn(styles.orbit, props.className)}
      style={{ width: size, height: size, "--size": `${size - 1}px` } as React.CSSProperties}
    >
      <span />
    </Status>
  );
}

/** Three by three squares, with a wave passing through them on the diagonal. */
export function GridPulse({ size = 40, ...props }: LoaderProps & { size?: number }) {
  return (
    <Status
      {...props}
      className={cn("grid grid-cols-3 gap-[3px]", props.className)}
      style={{ width: size, height: size }}
    >
      {Array.from({ length: 9 }, (_, index) => (
        <span
          key={index}
          className={styles.gridCell}
          style={{ "--step": (index % 3) + Math.floor(index / 3) } as React.CSSProperties}
        />
      ))}
    </Status>
  );
}

/** Five bars rising in turn. */
export function BarStack({ size = 40, ...props }: LoaderProps & { size?: number }) {
  return (
    <Status
      {...props}
      className={cn("grid grid-cols-5 gap-1", props.className)}
      style={{ width: size, height: size }}
    >
      {Array.from({ length: 5 }, (_, index) => (
        <span key={index} className={styles.bar} style={{ "--step": index } as React.CSSProperties} />
      ))}
    </Status>
  );
}

const FOLDS = [
  { axis: "0, 1, 0", origin: "100% 50%" },
  { axis: "1, 0, 0", origin: "50% 100%" },
  { axis: "1, 0, 0", origin: "50% 0%" },
  { axis: "0, 1, 0", origin: "0% 50%" },
];

/** A square that folds itself up, quarter by quarter. */
export function FoldSquare({ size = 40, ...props }: LoaderProps & { size?: number }) {
  return (
    <Status
      {...props}
      className={cn("grid grid-cols-2 gap-px", props.className)}
      style={{ width: size, height: size }}
    >
      {[FOLDS[0], FOLDS[1], FOLDS[2], FOLDS[3]].map((fold, index) => (
        <span
          key={index}
          className={styles.fold}
          style={{ "--axis": fold?.axis, "--origin": fold?.origin, "--step": index } as React.CSSProperties}
        />
      ))}
    </Status>
  );
}

/** A hazard-tape bar for work of unknown length. */
export function StripeBar(props: LoaderProps) {
  return <Status {...props} className={cn("h-3 w-full border border-current", styles.stripes, props.className)}>{null}</Status>;
}

/** A placeholder block with a scan passing over it. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn(styles.skeleton, className)} />;
}

/** A content placeholder for a card, so the page keeps its shape while loading. */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={cn("grid gap-3", className)}>
      <Skeleton className="aspect-[16/9] w-full" />
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
    </div>
  );
}
