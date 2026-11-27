"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Dialog } from "radix-ui";
import { createBooking, type Booking, type Resource, type Slot } from "@/features/booking/client";
import { formatInstant } from "@/features/booking/time";
import { formFailure, withMessage } from "@/features/data/errors";
import { FieldError } from "@/components/feedback/field-error";
import { useToast } from "@/components/feedback/toaster";
import { describeError } from "@/lib/errors";
import { ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";

type Props = {
  resource: Resource;
  /** The slot being booked. The sheet is open while this is set. */
  slot: Slot | null;
  /** The zone the times are shown in: the viewer's. */
  zone: string;
  onClose: () => void;
  onBooked: (booking: Booking) => void;
  /** Called when the slot is taken, so the calendar can refresh. */
  onTaken: () => void;
};

const inputClass =
  "h-12 w-full border border-rule bg-paper px-3 text-base text-ink outline-none focus-visible:border-ink";

/** A bottom sheet on phones and a dialog on wider screens. Focus is trapped and Escape closes it. */
export function ConfirmSheet({ resource, slot, zone, onClose, onBooked, onTaken }: Props) {
  return (
    <Dialog.Root
      open={slot !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] overflow-y-auto border-t border-ink bg-paper-raised p-6 text-ink sm:inset-x-auto sm:top-1/2 sm:left-1/2 sm:bottom-auto sm:w-[min(32rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:border">
          {slot && (
            <SheetBody
              key={slot.startsAt}
              resource={resource}
              slot={slot}
              zone={zone}
              onClose={onClose}
              onBooked={onBooked}
              onTaken={onTaken}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SheetBody({ resource, slot, zone, onClose, onBooked, onTaken }: Omit<Props, "slot"> & { slot: Slot }) {
  const maxSeats = Math.max(1, Math.min(slot.seatsLeft, resource.capacity));
  const [seats, setSeats] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Booking | null>(null);
  const toast = useToast();
  // One key per attempt. Retrying the same request reuses it; changing the booking gets a new one.
  const attempt = useRef<string | null>(null);

  function edited(update: () => void) {
    attempt.current = null;
    update();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFieldErrors({});
    attempt.current ??= crypto.randomUUID();
    try {
      const booking = await createBooking(
        resource.id,
        { startsAt: slot.startsAt, seats, note: note.trim() || undefined },
        attempt.current,
      );
      setDone(booking);
      onBooked(booking);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "CONFLICT") {
        // The slot is gone. The toast stays up after the sheet closes, and the calendar refreshes.
        toast.error(withMessage(describeError(caught, { context: "action" }), "That time was just taken. Pick another."));
        onTaken();
      } else {
        const failure = formFailure(caught, ["seats", "note"]);
        setFieldErrors(failure.named);
        if (failure.toast) toast.error(failure.toast);
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="grid gap-6">
        <Dialog.Title className="text-2xl font-medium tracking-[-0.02em]">You're booked.</Dialog.Title>
        <Dialog.Description className="text-ink-soft">
          {done.resourceName}, {formatInstant(done.startsAt, zone)}. A confirmation is on its way to your email.
        </Dialog.Description>
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="secondary">
            <Link href="/app/booking/bookings">My bookings</Link>
          </Button>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className="grid gap-5" onSubmit={submit} noValidate>
      <div className="grid gap-2">
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">Confirm booking</p>
        <Dialog.Title className="text-2xl font-medium tracking-[-0.02em]">{resource.name}</Dialog.Title>
        <Dialog.Description className="text-ink-soft">
          {formatInstant(slot.startsAt, zone)}
          <span className="block text-sm text-ink-muted">
            Times are in your time zone. This resource runs on {resource.timezone}, where it is{" "}
            {slot.localStart} to {slot.localEnd}.
          </span>
        </Dialog.Description>
      </div>

      {resource.capacity > 1 && (
        <div className="grid gap-2">
          <label htmlFor="booking-seats" className="font-mono text-[11px] tracking-[0.12em] uppercase">
            Seats
          </label>
          <input
            id="booking-seats"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxSeats}
            value={seats}
            onChange={(event) => edited(() => setSeats(Math.min(maxSeats, Math.max(1, Number(event.target.value) || 1))))}
            className={inputClass}
            aria-invalid={Boolean(fieldErrors.seats) || undefined}
            aria-describedby={fieldErrors.seats ? "booking-seats-error" : undefined}
          />
          <p className="text-sm text-ink-muted">{slot.seatsLeft} left at this time.</p>
          <FieldError id="booking-seats-error" message={fieldErrors.seats} />
        </div>
      )}

      <div className="grid gap-2">
        <label htmlFor="booking-note" className="font-mono text-[11px] tracking-[0.12em] uppercase">
          Note (optional)
        </label>
        <textarea
          id="booking-note"
          maxLength={500}
          rows={3}
          value={note}
          onChange={(event) => edited(() => setNote(event.target.value))}
          aria-invalid={Boolean(fieldErrors.note) || undefined}
          aria-describedby={fieldErrors.note ? "booking-note-error" : undefined}
          className="w-full border border-rule bg-paper px-3 py-2 text-base text-ink outline-none focus-visible:border-ink"
        />
        <p className="text-right font-mono text-[11px] text-ink-muted">{note.length} / 500</p>
        <FieldError id="booking-note-error" message={fieldErrors.note} />
      </div>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={busy} disabled={busy}>
          {busy ? "Booking…" : "Confirm booking"}
        </Button>
        <Dialog.Close asChild>
          <Button type="button" variant="secondary">
            Cancel
          </Button>
        </Dialog.Close>
      </div>
    </form>
  );
}
