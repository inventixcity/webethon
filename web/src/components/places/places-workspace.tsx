"use client";

import { useCallback, useState } from "react";
import { LocateFixed, Plus, X } from "lucide-react";
import { useTheme } from "@/components/theme/theme";
import { ErrorPage } from "@/components/errors/error-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCoordinate } from "@/features/places/geo";
import type { Focus } from "./map-canvas";
import { usePlacesInView, useNearby } from "@/features/places/use-places";
import type { Place } from "@/features/places/types";
import { MapView } from "./map-view";
import { PlaceForm } from "./place-form";
import { PlaceList, type PlaceListItem } from "./place-list";

const RADII = [1, 5, 20, 50] as const;
type Mode = "browse" | "nearby";
type Editor = { place?: Place } | null;
type Point = { lat: number; lng: number };

export function PlacesWorkspace() {
  const theme = useTheme();
  const view = usePlacesInView();
  const nearby = useNearby();
  const [mode, setMode] = useState<Mode>("browse");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [picking, setPicking] = useState(false);
  const [pickedPoint, setPickedPoint] = useState<Point | null>(null);
  const [userPoint, setUserPoint] = useState<Point | null>(null);
  const [radiusKm, setRadiusKm] = useState<number>(5);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState("");

  const listed: PlaceListItem[] = mode === "nearby" ? nearby.places : view.places;

  const focusPlace = useCallback((place: Place) => {
    setSelectedId(place.id);
    setFocus({ id: place.id, lat: place.lat, lng: place.lng, nonce: Date.now() });
  }, []);

  function updateSearch(value: string) {
    setSearch(value);
    view.setFilters((previous) => ({ ...previous, q: value }));
  }

  function updateCategory(value: string) {
    setCategory(value);
    view.setFilters((previous) => ({ ...previous, category: value }));
  }

  function openEditor(next: Editor) {
    setEditor(next);
    setPicking(false);
    setPickedPoint(null);
  }

  function locate() {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setLocateError("This browser can't share your location. You can still search the map.");
      return;
    }
    setLocating(true);
    setLocateError("");
    // Only runs on this click. The browser asks for permission the first time.
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const point = { lat: position.coords.latitude, lng: position.coords.longitude };
        setUserPoint(point);
        setMode("nearby");
        setFocus({ lat: point.lat, lng: point.lng, zoom: 13, nonce: Date.now() });
        void nearby.search(point.lat, point.lng, radiusKm);
      },
      (error) => {
        setLocating(false);
        setLocateError(
          error.code === error.PERMISSION_DENIED
            ? "Location access is off. Allow it in your browser settings, or search the map instead."
            : "We couldn't find your location. Try again.",
        );
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  function changeRadius(value: number) {
    setRadiusKm(value);
    if (userPoint) void nearby.search(userPoint.lat, userPoint.lng, value);
  }

  function leaveNearby() {
    setMode("browse");
    setUserPoint(null);
    nearby.clear();
  }

  function selectFromList(place: PlaceListItem) {
    focusPlace(place);
  }

  const selected = listed.find((place) => place.id === selectedId) ?? null;
  const listMessage =
    mode === "nearby"
      ? nearby.state === "loading"
        ? "Finding places near you…"
        : nearby.error
          ? "Couldn't load places near you."
          : `${nearby.places.length} ${nearby.places.length === 1 ? "place" : "places"} within ${radiusKm} km`
      : view.state === "loading"
        ? "Loading places in view…"
        : view.error
          ? "Couldn't load places in view."
          : `${view.places.length} ${view.places.length === 1 ? "place" : "places"} in view`;

  // A fatal first load replaces the workspace with its error page. Later failures keep the last list.
  if (view.error?.kind === "page" && !view.loaded) {
    return (
      <ErrorPage
        code={view.error.page}
        requestId={view.error.requestId}
        retryAfterSeconds={view.error.retryAfterSeconds}
        onRetry={view.reload}
      />
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-10 md:px-8 md:py-14">
      <header className="grid gap-4">
        <p className="font-mono text-[11px] tracking-[0.14em] uppercase text-ink-muted">01 / PLACES</p>
        <h1 className="font-sans text-4xl font-semibold tracking-tight md:text-5xl">Places</h1>
        <p className="max-w-prose font-sans text-base text-ink-soft">
          Pan and zoom the map, or use the list. Private places are only visible to you.
        </p>
      </header>

      <div className="mt-8 grid gap-4 md:grid-cols-[1fr_1fr_auto_auto] md:items-end">
        <div className="grid gap-2">
          <Label htmlFor="places-search">Search</Label>
          <Input id="places-search" type="search" value={search} onChange={(event) => updateSearch(event.target.value)} placeholder="Name or description" autoComplete="off" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="places-category">Category</Label>
          <Input id="places-category" value={category} onChange={(event) => updateCategory(event.target.value)} placeholder="cafe, park" autoComplete="off" />
        </div>
        <Button type="button" variant="secondary" onClick={locate} loading={locating}>
          <LocateFixed aria-hidden="true" />
          {locating ? "Locating…" : "Near me"}
        </Button>
        <Button type="button" onClick={() => openEditor({})}>
          <Plus aria-hidden="true" />
          Add place
        </Button>
      </div>

      {mode === "nearby" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 font-mono text-[11px] tracking-[0.12em] uppercase">
          <Label htmlFor="places-radius">Radius</Label>
          <select
            id="places-radius"
            value={radiusKm}
            onChange={(event) => changeRadius(Number(event.target.value))}
            className="h-10 border border-ink bg-paper px-3 font-mono text-xs uppercase"
          >
            {RADII.map((value) => (
              <option key={value} value={value}>
                {value} km
              </option>
            ))}
          </select>
          <Button type="button" variant="ghost" size="sm" onClick={leaveNearby}>
            <X aria-hidden="true" />
            Back to the map
          </Button>
        </div>
      ) : null}

      {locateError ? (
        <p role="alert" className="mt-4 font-mono text-[11px] tracking-wide">
          {locateError}
        </p>
      ) : null}

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <MapView
          places={listed}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id)}
          onViewportChange={(bbox) => {
            if (mode === "browse") view.setBbox(bbox);
          }}
          onEdit={(place) => openEditor({ place })}
          theme={theme}
          pick={{ active: picking, point: pickedPoint, onPick: (point) => setPickedPoint(point) }}
          focus={focus}
          className="h-[60vh] min-h-[360px] w-full"
        />

        <section aria-labelledby="places-list-title" className="grid content-start gap-4">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="places-list-title" className="font-sans text-xl font-semibold">
              {mode === "nearby" ? "Near you" : "In view"}
            </h2>
            <p role="status" aria-live="polite" className="font-mono text-[11px] tracking-[0.08em] text-ink-muted">
              {listMessage}
            </p>
          </div>
          {mode === "browse" && view.truncated ? (
            <p className="font-mono text-[11px] tracking-[0.04em] text-ink-muted">Only the first places in this view are shown. Zoom in to see more.</p>
          ) : null}
          <PlaceList
            label={mode === "nearby" ? "Places near you" : "Places in view"}
            places={listed}
            selectedId={selectedId}
            onSelect={selectFromList}
            emptyText={mode === "nearby" ? "No places within this distance. Try a larger radius." : "No places in this view. Pan the map or add one."}
          />
          {selected ? (
            <div className="grid gap-3 border-t border-ink pt-4">
              <p className="font-mono text-[11px] tracking-[0.08em] text-ink-muted">
                {formatCoordinate(selected.lat)}, {formatCoordinate(selected.lng)}
              </p>
              {selected.description ? <p className="whitespace-pre-line font-sans text-sm text-ink-soft">{selected.description}</p> : null}
              {selected.mine ? (
                <Button type="button" variant="secondary" size="sm" className="w-fit" onClick={() => openEditor({ place: selected })}>
                  Edit this place
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>

      {editor ? (
        <section id="place-editor" aria-label="Place details" className="mt-12 border-t border-ink pt-10">
          <PlaceForm
            key={editor.place?.id ?? "new"}
            place={editor.place}
            pickedPoint={pickedPoint}
            picking={picking}
            onTogglePick={() => setPicking((value) => !value)}
            onFocusPoint={(point) => {
              setPickedPoint(point);
              setFocus({ lat: point.lat, lng: point.lng, zoom: 15, nonce: Date.now() });
            }}
            onSaved={(saved) => {
              setEditor(null);
              setPicking(false);
              setPickedPoint(null);
              view.reload();
              if (mode === "nearby" && userPoint) void nearby.search(userPoint.lat, userPoint.lng, radiusKm);
              focusPlace(saved);
            }}
            onDeleted={(id) => {
              setEditor(null);
              setPicking(false);
              setPickedPoint(null);
              if (selectedId === id) setSelectedId(null);
              view.reload();
              if (mode === "nearby" && userPoint) void nearby.search(userPoint.lat, userPoint.lng, radiusKm);
            }}
            onCancel={() => openEditor(null)}
          />
        </section>
      ) : null}
    </main>
  );
}
