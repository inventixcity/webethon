import { describe, expect, it } from "vitest";
import { CsvParseError, parseCsv, rowsToObjects } from "./csv";

describe("parseCsv", () => {
  it("splits plain fields and rows", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps commas inside quoted fields", () => {
    expect(parseCsv('topic,stem\n"Data, Structures","Which is faster, A or B?"')).toEqual([
      ["topic", "stem"],
      ["Data, Structures", "Which is faster, A or B?"],
    ]);
  });

  it("turns a doubled quote into one literal quote", () => {
    expect(parseCsv('stem\n"He said ""hello"" twice"')).toEqual([["stem"], ['He said "hello" twice']]);
  });

  it("keeps newlines inside quoted fields", () => {
    expect(parseCsv('stem,explanation\n"line one\nline two","x"\n')).toEqual([
      ["stem", "explanation"],
      ["line one\nline two", "x"],
    ]);
  });

  it("handles CRLF line endings, including a CRLF inside quotes", () => {
    expect(parseCsv('a,b\r\n"x\r\ny",z\r\n')).toEqual([
      ["a", "b"],
      ["x\r\ny", "z"],
    ]);
  });

  it("accepts bare CR and LF without adding an empty row at the end", () => {
    expect(parseCsv("a\rb\n")).toEqual([["a"], ["b"]]);
    expect(parseCsv("a,b")).toEqual([["a", "b"]]);
  });

  it("keeps empty fields", () => {
    expect(parseCsv("a,,c\n,,\n")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
  });

  it("drops a leading byte order mark", () => {
    expect(parseCsv("﻿topic,stem\n")).toEqual([["topic", "stem"]]);
  });

  it("throws a CsvParseError with the line for an unclosed quote", () => {
    try {
      parseCsv('a,b\n"open field\nnever closed');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CsvParseError);
      expect((error as CsvParseError).line).toBe(2);
    }
  });
});

describe("rowsToObjects", () => {
  it("keys each row by its trimmed header and skips blank rows", () => {
    const rows = parseCsv(" topic , stem \nData,What is a stack?\n\n,\nGraphs,Define a cycle\n");
    expect(rowsToObjects(rows)).toEqual([
      { line: 2, values: { topic: "Data", stem: "What is a stack?" } },
      { line: 5, values: { topic: "Graphs", stem: "Define a cycle" } },
    ]);
  });

  it("fills missing cells with empty strings and ignores extra cells", () => {
    expect(rowsToObjects([["a", "b"], ["1", "2", "3"], ["4"]])).toEqual([
      { line: 2, values: { a: "1", b: "2" } },
      { line: 3, values: { a: "4", b: "" } },
    ]);
  });

  it("returns nothing for an empty file", () => {
    expect(rowsToObjects([])).toEqual([]);
  });
});
