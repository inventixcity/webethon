"use client";

import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import { ErrorPage } from "@/components/errors/error-page";
import { FieldError } from "@/components/feedback/field-error";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ApiError } from "@/lib/api/client";
import type { ErrorView } from "@/lib/errors";
import { useReportError } from "@/lib/errors/use-report-error";
import { humanize } from "@/components/data/schema-form";
import type { FieldSchema } from "@/features/data/client";
import {
  checkImportFile,
  importRecords,
  MAX_IMPORT_ROWS,
  type FailedRow,
  type ImportReport,
} from "@/features/transfer/client";
import { readFilePreviewFacts } from "@/features/transfer/preview";

/** How many problem rows the table shows. The rest are counted, not listed. */
const SHOWN_PROBLEMS = 100;
/** What a column the collection doesn't have says in the problem table. The server only reports "file" for it. */
const UNKNOWN_COLUMN_MESSAGE = "This column isn't a field in this collection, so it can't be imported.";

/**
 * A preview: the server's problem rows, the number of rows that would import, and any unknown columns by name.
 * The server's dry run reports created: 0 by design, so `ready` is counted here from the file.
 */
type Preview = { failed: FailedRow[]; ready: number; unknownColumns: string[] };

type Props = {
  entity: string;
  /** The collection's label, for the heading. */
  label: string;
  /** The collection's schema properties, so problem paths show the field titles. */
  fields?: Record<string, FieldSchema>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a real import, so the records list can reload. */
  onImported: () => void;
};

type Problem = { row: number; path: string; message: string };

/**
 * Import: choose a file, preview it (dryRun), then import (dryRun=false). Nothing is saved until the
 * final step. The file's own problems are field errors next to the file; a failed request is a toast,
 * or the error page for a fatal code.
 */
export function ImportDialog({ entity, label, fields, open, onOpenChange, onImported }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const [atomic, setAtomic] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acceptSkips, setAcceptSkips] = useState(false);
  const [result, setResult] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [fatal, setFatal] = useState<ErrorView | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const report = useReportError();

  function reset() {
    setFile(null);
    setFileError(undefined);
    setAtomic(true);
    setPreview(null);
    setAcceptSkips(false);
    setResult(null);
    setBusy(null);
    setFatal(null);
    setDragging(false);
  }

  function handleOpenChange(next: boolean) {
    // A run in progress keeps the dialog open, so its outcome is not lost.
    if (!next && busy !== null) return;
    if (!next) reset();
    onOpenChange(next);
  }

  function choose(next: File | undefined) {
    if (!next) return;
    const problem = checkImportFile(next);
    setPreview(null);
    setResult(null);
    setAcceptSkips(false);
    setFatal(null);
    setFileError(problem ?? undefined);
    if (problem) {
      // Clear the native input too, so the rejected file isn't still shown as chosen.
      if (inputRef.current) inputRef.current.value = "";
      setFile(null);
    } else {
      setFile(next);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy !== null) return;
    choose(event.dataTransfer.files[0]);
  }

  /**
   * Maps a failed request. Size and type are the file's problem (a field error on the file input, and the
   * rejected file is cleared so it can't be previewed). A fatal code is a page; the rest toast.
   */
  function failed(error: unknown) {
    const tooLarge = error instanceof ApiError && (error.status === 413 || error.code === "PAYLOAD_TOO_LARGE");
    const wrongType =
      error instanceof ApiError && (error.status === 415 || error.code === "UNSUPPORTED_MEDIA_TYPE");
    if (tooLarge || wrongType) {
      setFile(null);
      setPreview(null);
      if (inputRef.current) inputRef.current.value = "";
      setFileError(tooLarge ? "That file is too large. The limit is 4 MB." : "Choose a CSV or JSON file.");
      return;
    }
    const view = report(error, { context: "action" });
    if (view.kind === "page") setFatal(view);
  }

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    if (!file || busy !== null) return;
    setBusy("preview");
    setFatal(null);
    setResult(null);
    setAcceptSkips(false);
    try {
      // The file is read here too: the dry run counts nothing, so the ready count is the file's rows less the problem rows.
      const facts = await readFilePreviewFacts(file, fields ?? {}).catch(() => undefined);
      const report = await importRecords(entity, file, { dryRun: true, atomic });
      const unknownColumns = facts?.unknownColumns ?? [];
      const failed = nameUnknownColumns(report.failed, unknownColumns);
      const ready = facts?.rows === undefined ? report.created : Math.max(0, facts.rows - failed.length);
      setPreview({ failed, ready, unknownColumns });
    } catch (error) {
      setPreview(null);
      failed(error);
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!file || !preview || busy !== null) return;
    setBusy("import");
    setFatal(null);
    try {
      const outcome = await importRecords(entity, file, { dryRun: false, atomic });
      setResult(outcome);
      setPreview(null);
      onImported();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(null);
    }
  }

  const problems = preview?.failed ?? [];
  const problemCount = countProblems(problems);
  const importable = preview !== null && preview.ready > 0;
  const canImport =
    file !== null &&
    importable &&
    busy === null &&
    (problems.length === 0 || (!atomic && acceptSkips));

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] overflow-y-auto border-t border-ink bg-paper p-6 text-ink sm:inset-x-auto sm:top-1/2 sm:left-1/2 sm:bottom-auto sm:w-[min(40rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:border sm:p-8">
          {fatal ? (
            <>
              <Dialog.Title className="sr-only">Import records</Dialog.Title>
              <ErrorPage
                as="div"
                code={fatal.page}
                requestId={fatal.requestId}
                retryAfterSeconds={fatal.retryAfterSeconds}
                onRetry={() => setFatal(null)}
              />
            </>
          ) : (
            <>
              <p className="font-mono text-xs uppercase tracking-widest text-ink-muted">{label} / Import</p>
              <Dialog.Title className="mt-3 text-3xl font-medium tracking-[-0.02em]">Import records</Dialog.Title>
              <Dialog.Description className="mt-3 text-ink-soft">
                Upload a CSV or JSON file of up to {MAX_IMPORT_ROWS.toLocaleString()} rows and 4 MB. Preview it first.
                Nothing is saved until you import.
              </Dialog.Description>

              <form onSubmit={runPreview} className="mt-8 grid gap-6">
                <div className="grid gap-2">
                  <label htmlFor="import-file" className="font-mono text-xs uppercase tracking-widest">
                    File
                  </label>
                  <div
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                    className={`border border-dashed p-5 ${dragging ? "border-vermilion-deep bg-paper-sunk" : "border-ink"}`}
                  >
                    <input
                      ref={inputRef}
                      id="import-file"
                      type="file"
                      accept=".csv,.json,text/csv,application/json"
                      disabled={busy !== null}
                      aria-invalid={fileError ? true : undefined}
                      aria-describedby={fileError ? "import-file-error" : "import-file-help"}
                      onChange={(event) => choose(event.target.files?.[0])}
                      className="block w-full min-w-0 text-sm file:mr-4 file:border file:border-ink file:bg-paper-raised file:px-4 file:py-2 file:font-mono file:text-xs file:uppercase file:tracking-widest file:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vermilion"
                    />
                    <p id="import-file-help" className="mt-3 text-sm text-ink-muted">
                      Drop a file here or choose one. CSV or JSON, 4 MB at most.
                    </p>
                  </div>
                  <FieldError id="import-file-error" message={fileError} />
                </div>

                <div className="grid gap-2">
                  <label className="flex items-start gap-3 text-sm">
                    <Checkbox
                      checked={atomic}
                      disabled={busy !== null}
                      onCheckedChange={(checked) => {
                        // A preview is only valid for the options it ran with, so changing them clears it.
                        setAtomic(checked === true);
                        setPreview(null);
                        setResult(null);
                        setAcceptSkips(false);
                      }}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium">Import all or nothing</span>
                      <span className="block text-ink-muted">
                        {atomic
                          ? "If any row has a problem, nothing is imported."
                          : "Rows with problems are skipped. The rest are imported."}
                      </span>
                    </span>
                  </label>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Button type="submit" variant="secondary" disabled={!file || busy !== null} loading={busy === "preview"}>
                    Preview
                  </Button>
                  <Button type="button" onClick={() => void runImport()} disabled={!canImport} loading={busy === "import"}>
                    Import
                  </Button>
                </div>
              </form>

              {preview && (
                <section aria-label="Preview" className="mt-8 grid gap-4 border-t border-ink pt-6" role="status">
                  <p className="font-mono text-xs uppercase tracking-widest text-ink-muted">Preview</p>
                  <p className="text-xl font-medium">
                    {importable
                      ? `${plural(preview.ready, "record", "records")} ready to import.`
                      : problems.length > 0
                        ? "None of the rows can be imported yet."
                        : "No rows were found in this file."}
                  </p>
                  {problems.length > 0 && (
                    <>
                      <p className="text-vermilion-deep">
                        {plural(problemCount, "problem", "problems")} in {plural(problems.length, "row", "rows")}.{" "}
                        {atomic
                          ? "Fix them in the file, then preview again."
                          : "Those rows will be skipped if you import."}
                      </p>
                      {!atomic && (
                        <label className="flex items-start gap-3 text-sm">
                          <Checkbox
                            checked={acceptSkips}
                            onCheckedChange={(checked) => setAcceptSkips(checked === true)}
                            className="mt-0.5"
                          />
                          <span>
                            Skip the {plural(problems.length, "row", "rows")} with problems and import the rest.
                          </span>
                        </label>
                      )}
                      <ProblemTable rows={problems} fields={fields} />
                    </>
                  )}
                </section>
              )}

              {result && (
                <section aria-label="Result" className="mt-8 grid gap-4 border-t border-ink pt-6" role="status">
                  <p className="font-mono text-xs uppercase tracking-widest text-ink-muted">Result</p>
                  <p className="text-xl font-medium">
                    {result.created > 0 ? `Imported ${plural(result.created, "record", "records")}.` : "Nothing was imported."}
                  </p>
                  {result.failed.length > 0 && (
                    <>
                      <p className="text-vermilion-deep">
                        {plural(result.failed.length, "row", "rows")} {result.created > 0 ? "skipped" : "had problems"}.
                      </p>
                      <ProblemTable rows={result.failed} fields={fields} />
                    </>
                  )}
                </section>
              )}

              <div className="mt-8 flex justify-end">
                <Button variant="secondary" onClick={() => handleOpenChange(false)} disabled={busy !== null}>
                  {result ? "Done" : "Close"}
                </Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A table of the problems: the row, the field and the message. Long lists are cut to SHOWN_PROBLEMS. */
function ProblemTable({ rows, fields }: { rows: FailedRow[]; fields?: Record<string, FieldSchema> }) {
  const all: Problem[] = rows.flatMap((item) =>
    item.errors.length > 0
      ? item.errors.map((error) => ({ row: item.row, path: fieldLabel(error.path, fields), message: error.message }))
      : [{ row: item.row, path: "", message: "This row can't be imported." }],
  );
  const shown = all.slice(0, SHOWN_PROBLEMS);
  return (
    <div className="grid gap-2">
      <div className="max-h-72 overflow-auto border border-rule">
        <table className="w-full min-w-[420px] text-left text-sm">
          <thead className="sticky top-0 bg-paper-sunk">
            <tr>
              <th scope="col" className="px-3 py-2 font-mono text-xs font-medium uppercase tracking-widest">Row</th>
              <th scope="col" className="px-3 py-2 font-mono text-xs font-medium uppercase tracking-widest">Field</th>
              <th scope="col" className="px-3 py-2 font-mono text-xs font-medium uppercase tracking-widest">Problem</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((problem, index) => (
              <tr key={`${problem.row}-${problem.path}-${index}`} className="border-t border-rule align-top">
                <td className="px-3 py-2 tabular-nums">{problem.row}</td>
                <td className="px-3 py-2 break-all">{problem.path || "—"}</td>
                <td className="px-3 py-2 break-words">{problem.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {all.length > shown.length && (
        <p className="text-xs text-ink-muted">
          Showing the first {SHOWN_PROBLEMS} of {all.length} problems.
        </p>
      )}
    </div>
  );
}

/**
 * The server names a field by its dotted path ("address.city"). A schema field shows its title, with the
 * nested parts after it. An unknown column is shown exactly as the file wrote it, so the user can find it.
 */
function fieldLabel(path: string, fields: Record<string, FieldSchema> | undefined): string {
  if (!path) return "—";
  const [head, ...rest] = path.split(".");
  if (!fields || !Object.prototype.hasOwnProperty.call(fields, head)) return path;
  const base = fields[head]?.title ?? humanize(head);
  return [base, ...rest].join(" › ");
}

/**
 * The server reports an unknown column only as a whole-file error ("file") without its name. The file's header names
 * the columns, so each unknown one is listed under its own name in place of that error.
 */
function nameUnknownColumns(rows: FailedRow[], columns: string[]): FailedRow[] {
  if (columns.length === 0) return rows;
  return rows.map((item) => {
    if (!item.errors.some((error) => error.path === "file")) return item;
    return {
      row: item.row,
      errors: [
        ...item.errors.filter((error) => error.path !== "file"),
        ...columns.map((column) => ({ path: column, message: UNKNOWN_COLUMN_MESSAGE })),
      ],
    };
  });
}

function countProblems(rows: FailedRow[]) {
  return rows.reduce((total, item) => total + Math.max(1, item.errors.length), 0);
}

function plural(count: number, one: string, many: string) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
