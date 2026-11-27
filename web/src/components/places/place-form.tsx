"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Field, FieldError } from "@/components/auth/field";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/feedback/toaster";
import { createPlace, deletePlace, geocode, updatePlace } from "@/features/places/client";
import { formatCoordinate, parseCoordinates } from "@/features/places/geo";
import { placeSchema, type PlaceValues } from "@/features/places/schemas";
import type { GeocodeMatch, Place, PlaceInput } from "@/features/places/types";
import { formFailure } from "@/features/data/errors";
import { describeError } from "@/lib/errors";
import { cn } from "@/lib/utils";

type Point = { lat: number; lng: number };

export type PlaceFormProps = {
  /** Present when editing. Absent when adding a place. */
  place?: Place;
  /** The point most recently picked on the map, while picking is on. */
  pickedPoint: Point | null;
  picking: boolean;
  onTogglePick: () => void;
  /** Asks the map to move to a point, for example after an address is chosen. */
  onFocusPoint: (point: Point) => void;
  onSaved: (place: Place) => void;
  onDeleted: (id: string) => void;
  onCancel: () => void;
};

const FIELDS = ["name", "description", "address", "category", "visibility", "lat", "lng"] as const;

/** Blank numeric inputs are NaN, which the schema reports as "enter a latitude". */
const BLANK = Number.NaN;

/**
 * On edit, `visibility` is sent only when it differs from the place's saved value. The API refuses any
 * visibility value on a hidden place, even when it is already "public", so an unchanged field must stay out.
 */
function bodyFor(place: Place | undefined, input: PlaceInput): Partial<PlaceInput> {
  if (!place) return input;
  if (input.visibility !== place.visibility) return input;
  const body: Partial<PlaceInput> = { ...input };
  delete body.visibility;
  return body;
}

function valuesFor(place?: Place): PlaceValues {
  return {
    name: place?.name ?? "",
    description: place?.description ?? "",
    address: place?.address ?? "",
    category: place?.category ?? "",
    visibility: place?.visibility ?? "private",
    lat: place?.lat ?? BLANK,
    lng: place?.lng ?? BLANK,
  };
}

/** Rounds a map click to about 0.1 m, so the inputs stay readable. */
function roundPoint(value: number) {
  return Number(value.toFixed(6));
}

export function PlaceForm({ place, pickedPoint, picking, onTogglePick, onFocusPoint, onSaved, onDeleted, onCancel }: PlaceFormProps) {
  const titleId = useId();
  const hiddenNoticeId = useId();
  const hidden = place?.moderationHidden === true;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<GeocodeMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const toast = useToast();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    formState: { errors },
  } = useForm<PlaceValues>({
    resolver: zodResolver(placeSchema),
    defaultValues: valuesFor(place),
  });

  // Keyboard and screen reader users land on the form's heading when it opens.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // A map click while picking fills in the coordinates.
  useEffect(() => {
    if (!pickedPoint) return;
    setValue("lat", roundPoint(pickedPoint.lat), { shouldDirty: true, shouldValidate: true });
    setValue("lng", roundPoint(pickedPoint.lng), { shouldDirty: true, shouldValidate: true });
  }, [pickedPoint, setValue]);

  function choose(point: Point) {
    setValue("lat", roundPoint(point.lat), { shouldDirty: true, shouldValidate: true });
    setValue("lng", roundPoint(point.lng), { shouldDirty: true, shouldValidate: true });
    onFocusPoint(point);
  }

  async function findAddress() {
    const trimmed = query.trim();
    const coordinates = parseCoordinates(trimmed);
    if (coordinates) {
      setSearchError("");
      setMatches([]);
      choose(coordinates);
      return;
    }
    if (trimmed.length < 2) {
      setSearchError("Type at least 2 characters, or paste coordinates like 51.5074, -0.1278.");
      return;
    }
    setSearching(true);
    setSearchError("");
    try {
      setMatches(await geocode(trimmed));
    } catch (cause) {
      setMatches([]);
      toast.error(describeError(cause, { context: "action" }));
    } finally {
      setSearching(false);
    }
  }

  async function onSubmit(values: PlaceValues) {
    setPending(true);
    setStatus(null);
    const input: PlaceInput = { ...values, name: values.name.trim() };
    try {
      const saved = place
        ? await updatePlace(place.id, bodyFor(place, input))
        : await createPlace(input);
      setStatus({ tone: "info", text: place ? "Saved." : "Place added." });
      if (!place) reset(valuesFor());
      onSaved(saved);
    } catch (cause) {
      // A field the server names gets its message beside it. Anything else is a toast.
      const failure = formFailure(cause, FIELDS);
      for (const [field, message] of Object.entries(failure.named)) {
        setError(field as (typeof FIELDS)[number], { message });
      }
      if (failure.toast) toast.error(failure.toast);
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!place) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setPending(true);
    setStatus(null);
    try {
      await deletePlace(place.id);
      onDeleted(place.id);
    } catch (cause) {
      toast.error(describeError(cause, { context: "action" }));
      setPending(false);
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} aria-labelledby={titleId} className="grid gap-8 md:grid-cols-2">
      <div className="grid content-start gap-6 md:col-span-2 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <p className="font-mono text-[11px] tracking-[0.14em] uppercase text-ink-muted">{place ? "02 / EDIT PLACE" : "02 / ADD PLACE"}</p>
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="mt-2 font-sans text-3xl font-semibold tracking-tight outline-none md:text-4xl">
            {place ? place.name : "New place"}
          </h2>
        </div>
        <p className="font-mono text-[11px] tracking-[0.12em] uppercase text-ink-muted" aria-live="polite">
          {picking ? "Picking: click the map to set the point" : ""}
        </p>
      </div>

      <div className="grid content-start gap-6">
        <Field label="Name" autoComplete="off" maxLength={120} error={errors.name?.message} {...register("name")} />

        <div className="grid gap-2">
          <Label htmlFor="place-description">Description</Label>
          <textarea
            id="place-description"
            rows={4}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={errors.description ? "place-description-error" : undefined}
            className="w-full resize-y border border-current/30 bg-transparent p-3 font-sans text-base text-current caret-vermilion outline-none transition-colors duration-(--duration-fast) ease-(--ease-enter) hover:border-current/60 focus:border-ink"
            {...register("description")}
          />
          <FieldError id="place-description-error" message={errors.description?.message} />
        </div>

        <Field label="Address" autoComplete="off" error={errors.address?.message} {...register("address")} />
        <Field label="Category" autoComplete="off" error={errors.category?.message} placeholder="cafe, park, shop" {...register("category")} />

        <fieldset className="grid gap-3">
          <legend className="font-mono text-[11px] font-medium tracking-[0.12em] uppercase">Who can see it</legend>
          {hidden ? (
            <p id={hiddenNoticeId} className="border border-rule p-3 font-mono text-[11px] leading-relaxed tracking-wide">
              This place is hidden by moderation. Visibility can&apos;t be changed while it is hidden.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            {(["private", "public"] as const).map((option) => (
              <label key={option} className={cn("relative", hidden ? "cursor-not-allowed opacity-50" : "cursor-pointer")}>
                <input
                  type="radio"
                  value={option}
                  disabled={hidden}
                  aria-describedby={hidden ? hiddenNoticeId : undefined}
                  className="peer sr-only"
                  {...register("visibility")}
                />
                <span className="grid h-12 place-items-center border border-ink font-mono text-xs tracking-[0.12em] uppercase peer-checked:bg-ink peer-checked:text-paper peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-vermilion">
                  {option === "private" ? "Only me" : "Everyone"}
                </span>
              </label>
            ))}
          </div>
          <FieldError message={errors.visibility?.message} />
        </fieldset>
      </div>

      <div className="grid content-start gap-6">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Latitude" type="number" step="any" inputMode="decimal" error={errors.lat?.message} {...register("lat", { valueAsNumber: true })} />
          <Field label="Longitude" type="number" step="any" inputMode="decimal" error={errors.lng?.message} {...register("lng", { valueAsNumber: true })} />
        </div>

        <div className="flex flex-wrap gap-3">
          <Button type="button" variant="secondary" size="sm" aria-pressed={picking} onClick={onTogglePick}>
            {picking ? "Done picking" : "Pick on map"}
          </Button>
        </div>

        <div className="grid gap-3">
          <label htmlFor="place-find" className="font-mono text-[11px] font-medium tracking-[0.12em] uppercase">
            Find an address
          </label>
          <div className="flex items-end gap-3">
            <input
              id="place-find"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void findAddress();
                }
              }}
              placeholder="An address, or 51.5074, -0.1278"
              autoComplete="off"
              className="h-12 min-w-0 flex-1 border-0 border-b border-current/30 bg-transparent font-sans text-base outline-none placeholder:text-current/35 hover:border-current/60 focus:border-ink"
            />
            <Button type="button" variant="secondary" size="sm" onClick={() => void findAddress()} loading={searching}>
              {searching ? "Searching…" : "Find"}
            </Button>
          </div>
          {searchError ? <p role="alert" className="font-mono text-[11px] tracking-wide">{searchError}</p> : null}
          {matches.length ? (
            <ul aria-label="Address matches" className="grid border-t border-rule">
              {matches.map((match) => (
                <li key={`${match.lat},${match.lng},${match.label}`} className="border-b border-rule">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => choose({ lat: match.lat, lng: match.lng })}
                    className="h-auto w-full flex-col items-stretch justify-start gap-0 px-1 py-3 text-left font-sans text-sm normal-case tracking-normal whitespace-normal hover:no-underline"
                  >
                    <span className="block">{match.label}</span>
                    <span className="block font-mono text-[11px] text-ink-muted">
                      {formatCoordinate(match.lat)}, {formatCoordinate(match.lng)}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:col-span-2">
        {status ? (
          <p role={status.tone === "error" ? "alert" : "status"} className={cn("font-mono text-[11px] tracking-wide", status.tone === "error" && "text-vermilion-deep")}>
            {status.text}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pending={pending} pendingLabel="Saving…" size="default" className="w-full sm:w-auto">
            {place ? "Save changes" : "Add place"}
          </SubmitButton>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          {place?.mine ? (
            <Button type="button" variant="danger" onClick={() => void remove()} disabled={pending} className="sm:ml-auto">
              {confirmDelete ? "Confirm delete" : "Delete place"}
            </Button>
          ) : null}
        </div>
      </div>
    </form>
  );
}
