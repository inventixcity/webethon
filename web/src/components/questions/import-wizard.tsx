"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api/client";
import { describeError } from "@/lib/errors";
import type { ImportResult } from "@/lib/exam/types";
import { useToast } from "@/components/feedback/toaster";
import { FilePicker } from "@/components/import/file-picker";
import { ImportErrors } from "@/components/import/import-errors";
import { ImportTable } from "@/components/import/import-table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MonoLabel } from "./parts";
import {
  CSV_COLUMNS,
  ImportFileError,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  PREVIEW_COLUMNS,
  columnForImportPath,
  parseImportFile,
  previewRow,
  type ParsedImport,
} from "./import-model";

type Stage = "choose" | "preview" | "done";

/**
 * Bulk import for questions: choose a file, preview it, validate it with a dry run, then import in one go.
 * Nothing is written until the dry run has come back with zero errors.
 */
export function QuestionImportWizard() {
  const toast = useToast();
  const [stage, setStage] = useState<Stage>("choose");
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [checked, setChecked] = useState<ImportResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [created, setCreated] = useState(0);

  function reset() {
    setStage("choose");
    setFileName("");
    setParsed(null);
    setFileError(null);
    setChecked(null);
    setRequestError(null);
  }

  async function readFile(file: File) {
    setFileError(null);
    setRequestError(null);
    setChecked(null);
    try {
      const text = await file.text();
      const result = parseImportFile(text, file.name);
      if (result.rows.length === 0) throw new ImportFileError("The file has no question rows.");
      if (result.rows.length > MAX_IMPORT_ROWS) {
        throw new ImportFileError(
          `Import at most ${MAX_IMPORT_ROWS} questions at a time. This file has ${result.rows.length}. Split it and import each part.`,
        );
      }
      setFileName(file.name);
      setParsed(result);
      setStage("preview");
    } catch (error) {
      const message = error instanceof ImportFileError ? error.message : "That file could not be read.";
      setFileError(message);
    }
  }

  async function send(dryRun: boolean): Promise<ImportResult | null> {
    if (!parsed) return null;
    setRequestError(null);
    try {
      return await api<ImportResult>("/questions/import", {
        method: "POST",
        body: { rows: parsed.rows, dryRun },
      });
    } catch (error) {
      const view = describeError(error, { context: "action" });
      setRequestError(view.message);
      toast.error(view);
      return null;
    }
  }

  async function validate() {
    setValidating(true);
    const result = await send(true);
    setValidating(false);
    if (result) setChecked(result);
  }

  async function runImport() {
    if (!parsed || !checked || checked.errors.length > 0) return;
    setImporting(true);
    const result = await send(false);
    setImporting(false);
    if (result) {
      setCreated(result.created);
      setStage("done");
      toast.success(`${result.created} ${result.created === 1 ? "question" : "questions"} imported.`);
    }
  }

  const errors = checked?.errors ?? [];
  const canImport = checked !== null && errors.length === 0;
  const rowCount = parsed?.rows.length ?? 0;

  return (
    <div className="grid gap-12">
      <ol aria-label="Import steps" className="flex flex-wrap gap-x-8 gap-y-3 border-y border-rule py-4">
        {[
          ["choose", "01 Choose file"],
          ["preview", "02 Validate"],
          ["done", "03 Import"],
        ].map(([key, label]) => {
          const current = key === stage;
          return (
            <li
              key={key}
              aria-current={current ? "step" : undefined}
              className={cn(
                "font-mono text-[11px] tracking-[0.14em] uppercase",
                current ? "text-vermilion-deep" : "text-ink-muted",
              )}
            >
              {label}
            </li>
          );
        })}
      </ol>

      {stage === "choose" && (
        <section aria-labelledby="choose-heading" className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
          <div className="grid gap-4">
            <h2 id="choose-heading" className="font-sans text-xl font-medium tracking-[-0.02em]">
              Choose a CSV or JSON file
            </h2>
            <FilePicker
              accept=".csv,.json,text/csv,application/json"
              maxBytes={MAX_IMPORT_BYTES}
              hint="CSV or JSON / 1 MB maximum / 500 questions at most"
              onFile={(file) => void readFile(file)}
              onReject={(message) => setFileError(message)}
            />
            {fileError && (
              <p role="alert" className="font-sans text-sm text-vermilion-deep">
                {fileError}
              </p>
            )}
          </div>
          <SampleGuide />
        </section>
      )}

      {stage === "preview" && parsed && (
        <section aria-labelledby="preview-heading" className="grid gap-8">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule pb-4">
            <div className="grid gap-1">
              <h2 id="preview-heading" className="font-sans text-xl font-medium tracking-[-0.02em]">
                {fileName}
              </h2>
              <MonoLabel>
                {rowCount} {rowCount === 1 ? "question" : "questions"} · {parsed.format.toUpperCase()}
              </MonoLabel>
            </div>
            <Button
              variant="link"
              onClick={reset}
            >
              Choose another file
            </Button>
          </div>

          <ImportTable
            caption="Questions in this file"
            columns={PREVIEW_COLUMNS}
            rows={parsed.rows.map((row) => previewRow(row))}
            errors={errors}
            columnForPath={columnForImportPath}
          />

          {requestError && (
            <div role="alert" className="border border-vermilion-deep p-4 font-sans text-sm text-ink">
              {requestError}
            </div>
          )}

          {checked && errors.length === 0 && (
            <div role="status" className="grid gap-1 border border-ink bg-paper-raised p-5">
              <MonoLabel>Check passed / 00</MonoLabel>
              <p className="font-sans text-base text-ink">
                All {rowCount} {rowCount === 1 ? "question is" : "questions are"} valid. Nothing has been imported yet.
              </p>
            </div>
          )}

          <ImportErrors errors={errors} rowLabel={(row) => `Row ${row}`} />

          <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center gap-3 border-t border-ink bg-paper px-5 py-4 md:-mx-8 md:px-8">
            <Button variant="secondary" loading={validating} onClick={() => void validate()}>
              {checked ? "Validate again" : "Validate"}
            </Button>
            <Button loading={importing} disabled={!canImport || importing} onClick={() => void runImport()}>
              {canImport
                ? `Import ${rowCount} ${rowCount === 1 ? "question" : "questions"}`
                : checked
                  ? `Fix ${errors.length} ${errors.length === 1 ? "problem" : "problems"} to import`
                  : `Import ${rowCount} ${rowCount === 1 ? "question" : "questions"}`}
            </Button>
          </div>
        </section>
      )}

      {stage === "done" && (
        <section aria-labelledby="done-heading" className="grid gap-6 border border-ink bg-paper-raised p-8 md:p-12">
          <MonoLabel>Import complete / 03</MonoLabel>
          <h2 id="done-heading" className="text-[clamp(2rem,4vw,3rem)] leading-[1.02] font-medium tracking-[-0.03em]">
            {created} {created === 1 ? "question" : "questions"} added to your bank.
          </h2>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/app/examiner/questions">Back to the question bank</Link>
            </Button>
            <Button variant="secondary" onClick={reset}>
              Import another file
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

function SampleGuide() {
  return (
    <aside aria-labelledby="sample-heading" className="grid content-start gap-5 border-t border-rule pt-6 lg:border-t-0 lg:pt-0">
      <h2 id="sample-heading" className="font-sans text-base font-medium">
        File format
      </h2>
      <p className="font-sans text-sm text-ink-soft">
        One row per question. Option columns A to F are used for choice questions. Leave them empty for written
        questions, and fill in rubric and maxWords instead.
      </p>
      <div className="grid gap-2">
        <MonoLabel>Columns</MonoLabel>
        <p className="font-mono text-[11px] leading-relaxed break-words text-ink-soft">{CSV_COLUMNS.join(", ")}</p>
      </div>
      <p className="font-sans text-sm text-ink-soft">
        Correct answers are option letters separated by commas, for example <span className="font-mono">A,C</span>.
        multiRule is all_or_nothing, partial or partial_penalty.
      </p>
      <p className="font-sans text-sm text-ink-soft">
        JSON files hold an array of question objects with the same fields. Options are objects with an id and text.
      </p>
      <Button asChild variant="secondary" size="sm" className="w-fit">
        <a href="/samples/questions-sample.csv" download>
          Download sample CSV
        </a>
      </Button>
    </aside>
  );
}
