import { api, ApiError } from "@/lib/api/client";

/** Types for the booking API. Field names match docs/BOOKING.md. */

export type Visibility = "private" | "public";
export type BookingStatus = "confirmed" | "cancelled";

export type Resource = {
  id: string;
  name: string;
  description: string;
  /** IANA name, e.g. Europe/London. Slots are laid out in this zone. */
  timezone: string;
  slotMinutes: number;
  capacity: number;
  visibility: Visibility;
  isOwner: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ResourceInput = {
  name: string;
  description?: string;
  timezone: string;
  slotMinutes: number;
  capacity: number;
  visibility?: Visibility;
};

export type Slot = {
  /** UTC instant, RFC 3339. */
  startsAt: string;
  endsAt: string;
  /** Local date and times in the resource's zone, for labels. */
  localDate: string;
  localStart: string;
  localEnd: string;
  seatsLeft: number;
};

export type SlotsResponse = {
  timezone: string;
  slotMinutes: number;
  capacity: number;
  from: string;
  to: string;
  slots: Slot[];
};

export type Booking = {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceTimezone: string;
  bookerName: string;
  startsAt: string;
  endsAt: string;
  seats: number;
  status: BookingStatus;
  note: string;
  createdAt: string;
  cancelledAt: string | null;
};

/** One weekly window. weekday 0 is Sunday. endTime "24:00" means until midnight. */
export type Rule = { weekday: number; startTime: string; endTime: string };

export type Exception = {
  date: string;
  closed: boolean;
  startTime: string | null;
  endTime: string | null;
};

export type Availability = {
  timezone: string;
  rules: Rule[];
  exceptions: Exception[];
};

export type ExceptionInput = { closed: boolean; startTime?: string; endTime?: string };

export type Page<T> = { data: T[]; nextCursor: string | null };

type Envelope<T> = { data: T; meta?: { nextCursor?: string | null } };
type ErrorBody = { error?: { code?: string; message?: string; details?: unknown; requestId?: string } };

const UNAVAILABLE = "We can't reach the service right now. Check your connection and try again.";

/**
 * Like `api()`, but keeps the envelope's `meta`, which carries the cursor for the next page.
 * Failures are thrown as ApiError, the same as `api()`.
 */
async function envelope<T>(path: `/${string}`, options: { method?: string; body?: unknown } = {}): Promise<Envelope<T>> {
  const headers = new Headers({ accept: "application/json" });
  let payload: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(options.body);
  }
  let response: Response;
  let text: string;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? "GET",
      headers,
      body: payload,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    text = await response.text();
  } catch {
    throw new ApiError({ code: "UNAVAILABLE", status: 0, message: UNAVAILABLE });
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const error = (parsed as ErrorBody | undefined)?.error;
    throw new ApiError({
      code: error?.code ?? `HTTP_${response.status}`,
      status: response.status,
      message: error?.message || "Something went wrong. Please try again.",
      details: error?.details,
      requestId: error?.requestId,
    });
  }
  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    throw new ApiError({ code: "BAD_RESPONSE", status: response.status, message: "The server returned an invalid response." });
  }
  return parsed as Envelope<T>;
}

function page<T>(result: Envelope<T[]>): Page<T> {
  return { data: result.data, nextCursor: result.meta?.nextCursor ?? null };
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export async function listResources(cursor?: string): Promise<Page<Resource>> {
  return page(await envelope<Resource[]>(`/booking/resources${query({ limit: 50, cursor })}`));
}

export function getResource(id: string) {
  return api<Resource>(`/booking/resources/${encodeURIComponent(id)}`);
}

export function createResource(input: ResourceInput) {
  return api<Resource>("/booking/resources", { method: "POST", body: input });
}

export function updateResource(id: string, patch: Partial<ResourceInput>) {
  return api<Resource>(`/booking/resources/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
}

export function deleteResource(id: string) {
  return api<void>(`/booking/resources/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function getAvailability(id: string) {
  return api<Availability>(`/booking/resources/${encodeURIComponent(id)}/availability`);
}

export async function setRules(id: string, rules: Rule[]): Promise<Rule[]> {
  const result = await api<{ rules: Rule[] }>(`/booking/resources/${encodeURIComponent(id)}/availability`, {
    method: "PUT",
    body: { rules },
  });
  return result.rules;
}

export function setException(id: string, date: string, input: ExceptionInput) {
  return api<Exception>(`/booking/resources/${encodeURIComponent(id)}/exceptions/${date}`, {
    method: "PUT",
    body: input,
  });
}

export function deleteException(id: string, date: string) {
  return api<void>(`/booking/resources/${encodeURIComponent(id)}/exceptions/${date}`, { method: "DELETE" });
}

/** Slots between two local dates in the resource's zone (at most 62 days). */
export function getSlots(id: string, from: string, to: string) {
  return api<SlotsResponse>(`/booking/resources/${encodeURIComponent(id)}/slots${query({ from, to })}`);
}

/** `key` makes retries safe: the same key with the same body returns the first booking. */
export function createBooking(id: string, input: { startsAt: string; seats?: number; note?: string }, key: string) {
  return api<Booking>(`/booking/resources/${encodeURIComponent(id)}/bookings`, {
    method: "POST",
    body: input,
    headers: { "Idempotency-Key": key },
  });
}

export async function listMyBookings(when: "upcoming" | "past", cursor?: string): Promise<Page<Booking>> {
  return page(await envelope<Booking[]>(`/booking/bookings${query({ when, limit: 20, cursor })}`));
}

export async function listResourceBookings(id: string, when: "upcoming" | "past", cursor?: string): Promise<Page<Booking>> {
  return page(
    await envelope<Booking[]>(`/booking/resources/${encodeURIComponent(id)}/bookings${query({ when, limit: 20, cursor })}`),
  );
}

export function cancelBooking(id: string) {
  return api<Booking>(`/booking/bookings/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}
