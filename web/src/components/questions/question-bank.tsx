"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { api } from "@/lib/api/client";
import { describeError } from "@/lib/errors";
import type { Page, Question, QuestionKind } from "@/lib/exam/types";
import { useToast } from "@/components/feedback/toaster";
import { Button } from "@/components/ui/button";
import { EmptyState as SharedEmptyState } from "@/components/ui/empty-state";
import { BrailleSpinner } from "@/components/loaders/text-loaders";
import { cn } from "@/lib/utils";
import { KIND_LABEL, KINDS, formatObserved, formatUpdated } from "./model";
import { boxInputClass, DifficultySquares, KindChip, MonoLabel, selectClass } from "./parts";

type TopicCount = { topic: string; count: number };
type Filters = { topic: string; difficulty: string; kind: string; q: string };

const EMPTY_FILTERS: Filters = { topic: "", difficulty: "", kind: "", q: "" };
const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

function buildQuery(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.topic) params.set("topic", filters.topic);
  if (filters.difficulty) params.set("difficulty", filters.difficulty);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.q) params.set("q", filters.q);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(PAGE_SIZE));
  return `/questions?${params.toString()}`;
}

/** The question bank: filters, cursor pagination, and row actions. The server does all the filtering. */
export function QuestionBank() {
  const toast = useToast();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [searchText, setSearchText] = useState("");
  const [topics, setTopics] = useState<TopicCount[]>([]);
  const [items, setItems] = useState<Question[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Question | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Only the newest request may write results. A slow older response must not overwrite a newer filter.
  const latest = useRef(0);

  // Debounce the search box: the query is sent 300 ms after the last keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) => (current.q === searchText.trim() ? current : { ...current, q: searchText.trim() }));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const load = useCallback(async (next: Filters) => {
    const request = ++latest.current;
    setStatus("loading");
    try {
      const page = await api<Page<Question>>(buildQuery(next, null) as `/${string}`);
      if (request !== latest.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setStatus("ready");
    } catch (error) {
      if (request !== latest.current) return;
      setItems([]);
      setNextCursor(null);
      setStatus("error");
      toast.error(describeError(error, { context: "page" }));
    }
  }, [toast]);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  useEffect(() => {
    let active = true;
    api<TopicCount[]>("/questions/topics")
      .then((list) => {
        if (active) setTopics(list);
      })
      .catch(() => {
        if (active) setTopics([]);
      });
    return () => {
      active = false;
    };
  }, []);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const request = latest.current;
    setLoadingMore(true);
    try {
      const page = await api<Page<Question>>(buildQuery(filters, nextCursor) as `/${string}`);
      if (request !== latest.current) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setLoadingMore(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api(`/questions/${pendingDelete.id}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== pendingDelete.id));
      toast.success("Question deleted. Published exams keep their own copy.");
      setPendingDelete(null);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setDeleting(false);
    }
  }

  const hasFilters = Boolean(filters.topic || filters.difficulty || filters.kind || filters.q);

  function clearFilters() {
    setSearchText("");
    setFilters(EMPTY_FILTERS);
  }

  return (
    <div className="grid gap-10">
      <form
        role="search"
        aria-label="Filter questions"
        onSubmit={(event) => event.preventDefault()}
        className="grid gap-5 border-y border-rule py-6 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]"
      >
        <label className="grid gap-2">
          <MonoLabel>Search</MonoLabel>
          <input
            type="search"
            value={searchText}
            maxLength={100}
            placeholder="Stem or topic"
            onChange={(event) => setSearchText(event.target.value)}
            className={boxInputClass}
          />
        </label>
        <label className="grid gap-2">
          <MonoLabel>Topic</MonoLabel>
          <select
            className={selectClass}
            value={filters.topic}
            onChange={(event) => setFilters((current) => ({ ...current, topic: event.target.value }))}
          >
            <option value="">All topics</option>
            {topics.map((item) => (
              <option key={item.topic} value={item.topic}>
                {item.topic} ({item.count})
              </option>
            ))}
            {filters.topic && !topics.some((item) => item.topic === filters.topic) && (
              <option value={filters.topic}>{filters.topic}</option>
            )}
          </select>
        </label>
        <label className="grid gap-2">
          <MonoLabel>Difficulty</MonoLabel>
          <select
            className={selectClass}
            value={filters.difficulty}
            onChange={(event) => setFilters((current) => ({ ...current, difficulty: event.target.value }))}
          >
            <option value="">Any difficulty</option>
            {[1, 2, 3, 4, 5].map((level) => (
              <option key={level} value={String(level)}>
                {level} of 5
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-2">
          <MonoLabel>Kind</MonoLabel>
          <select
            className={selectClass}
            value={filters.kind}
            onChange={(event) => setFilters((current) => ({ ...current, kind: event.target.value }))}
          >
            <option value="">Any kind</option>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <p role="status" className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">
          {status === "loading" ? (
            <BrailleSpinner label="Loading questions" className="text-ink-soft" />
          ) : status === "error" ? (
            "Questions did not load"
          ) : (
            `${items.length} shown${nextCursor ? ", more available" : ""}`
          )}
        </p>
        {hasFilters && (
          <Button variant="link" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>

      {status === "error" && (
        <div role="alert" className="grid gap-4 border border-vermilion-deep p-6">
          <p className="text-xl font-medium tracking-[-0.02em]">We couldn&apos;t load the question bank.</p>
          <div>
            <Button variant="secondary" onClick={() => void load(filters)}>
              Try again
            </Button>
          </div>
        </div>
      )}

      {status === "loading" && items.length === 0 && (
        <div aria-busy="true" aria-label="Loading questions" className="grid gap-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-28 animate-pulse border border-rule bg-paper-raised motion-reduce:animate-none" />
          ))}
        </div>
      )}

      {status === "ready" && items.length === 0 && (
        <EmptyState hasFilters={hasFilters} onClear={clearFilters} />
      )}

      {items.length > 0 && (
        <ul aria-busy={status === "loading" || undefined} className="divide-y divide-rule border-t border-rule">
          {items.map((question) => (
            <QuestionRow key={question.id} question={question} onDelete={() => setPendingDelete(question)} />
          ))}
        </ul>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      )}

      <DeleteDialog
        question={pendingDelete}
        busy={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function QuestionRow({ question, onDelete }: { question: Question; onDelete: () => void }) {
  const stem = question.stem.length > 240 ? `${question.stem.slice(0, 240)}…` : question.stem;
  const href = `/app/examiner/questions/${question.id}`;

  return (
    <li className="grid gap-4 py-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-8">
      <div className="grid min-w-0 gap-3">
        <p className="font-mono text-[11px] tracking-[0.12em] text-ink-muted uppercase">{question.topic}</p>
        <Link
          href={href}
          className="line-clamp-2 font-sans text-lg leading-snug text-ink transition-colors duration-(--duration-fast) hover:text-vermilion-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
        >
          {stem}
        </Link>
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-3 font-mono text-[11px] tracking-[0.08em] uppercase">
          <div className="flex items-center gap-2">
            <dt className="sr-only">Difficulty</dt>
            <dd className="flex items-center gap-2">
              <DifficultySquares value={question.difficulty} />
              <span className="text-ink-muted">{question.difficulty}/5</span>
            </dd>
          </div>
          <div>
            <dt className="sr-only">Kind</dt>
            <dd>
              <KindChip kind={question.kind} />
            </dd>
          </div>
          <div className="text-ink-soft">
            <dt className="sr-only">Marks</dt>
            <dd>
              {question.marks} {question.marks === 1 ? "mark" : "marks"}
              {question.negativeMarks > 0 && <span className="text-ink-muted"> / −{question.negativeMarks}</span>}
            </dd>
          </div>
          <div className="text-ink-soft">
            <dt className="sr-only">Observed</dt>
            <dd>{formatObserved(question)}</dd>
          </div>
          <div className="text-ink-muted">
            <dt className="inline">Updated </dt>
            <dd className="inline">
              <time dateTime={question.updatedAt}>{formatUpdated(question.updatedAt)}</time>
            </dd>
          </div>
        </dl>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        <Button asChild variant="secondary" size="sm">
          <Link href={href} aria-label={`Edit question: ${stem.slice(0, 60)}`}>
            Edit
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-vermilion-deep"
          aria-label={`Delete question: ${stem.slice(0, 60)}`}
          onClick={onDelete}
        >
          Delete
        </Button>
      </div>
    </li>
  );
}

function EmptyState({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  if (hasFilters) {
    return (
      <SharedEmptyState
        art="empty-questions"
        eyebrow="No matches / 00"
        title="No questions match these filters."
        actions={
          <Button variant="secondary" onClick={onClear}>
            Clear filters
          </Button>
        }
      />
    );
  }
  return (
    <SharedEmptyState
      art="empty-questions"
      eyebrow="Empty bank / 00"
      title="Your bank is empty."
      description="Create a question or import a batch."
      actions={
        <>
          <Button asChild>
            <Link href="/app/examiner/questions/new">New question</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/app/examiner/questions/import">Import</Link>
          </Button>
        </>
      }
    />
  );
}

function DeleteDialog({
  question,
  busy,
  onCancel,
  onConfirm,
}: {
  question: Question | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={question !== null} onOpenChange={(open) => !open && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 grid w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 gap-6 border border-ink bg-paper p-6 text-ink md:p-8",
            "focus-visible:outline-none",
          )}
        >
          <MonoLabel>Confirm / delete</MonoLabel>
          <Dialog.Title className="text-2xl leading-tight font-medium tracking-[-0.02em]">
            Delete this question?
          </Dialog.Title>
          <Dialog.Description className="font-sans text-base text-ink-soft">
            {question ? `“${question.stem.slice(0, 120)}${question.stem.length > 120 ? "…" : ""}”` : ""} It leaves the
            bank. Exams already published keep their copy.
          </Dialog.Description>
          <div className="flex flex-wrap justify-end gap-3">
            <Dialog.Close asChild>
              <Button variant="secondary" disabled={busy}>
                Keep question
              </Button>
            </Dialog.Close>
            <Button variant="danger" loading={busy} onClick={onConfirm}>
              Delete question
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
