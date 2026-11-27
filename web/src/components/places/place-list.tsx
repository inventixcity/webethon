import { formatDistance } from "@/features/places/geo";
import type { Place } from "@/features/places/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PlaceListItem = Place & { distanceM?: number };

type PlaceListProps = {
  label: string;
  places: PlaceListItem[];
  selectedId: string | null;
  onSelect: (place: PlaceListItem) => void;
  emptyText: string;
  className?: string;
};

/**
 * The places as a keyboard-friendly list, the text alternative to the map. Every marker has a row here,
 * and every row is a real button, so nothing depends on pointing at the map.
 */
export function PlaceList({ label, places, selectedId, onSelect, emptyText, className }: PlaceListProps) {
  if (!places.length) {
    return <p className={cn("font-sans text-ink-soft", className)}>{emptyText}</p>;
  }
  return (
    <ol aria-label={label} className={cn("grid border-t border-ink", className)}>
      {places.map((place) => {
        const selected = place.id === selectedId;
        return (
          <li key={place.id} className="border-b border-rule">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onSelect(place)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "grid h-auto w-full grid-cols-[1fr_auto] items-stretch justify-stretch gap-x-4 gap-y-1 px-1 py-3 text-left font-sans normal-case tracking-normal hover:no-underline",
                selected && "bg-paper-sunk",
              )}
            >
              <span className="min-w-0 truncate font-sans text-base font-medium">{place.name}</span>
              {typeof place.distanceM === "number" ? (
                <span className="font-mono text-[11px] tracking-[0.08em] text-ink-muted tabular-nums">{formatDistance(place.distanceM)}</span>
              ) : (
                <span className="font-mono text-[11px] tracking-[0.08em] text-ink-muted uppercase">{place.mine ? "Mine" : place.visibility}</span>
              )}
              <span className="col-span-2 min-w-0 truncate font-mono text-[11px] tracking-[0.04em] text-ink-muted">
                {[place.category, place.address].filter(Boolean).join(" · ") || "No address added"}
              </span>
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
