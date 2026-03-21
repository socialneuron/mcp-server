import { describe, it, expect } from "vitest";
import {
  formatTable,
  formatCsv,
  resolveOutputFormat,
  type OutputFormat,
} from "./parse.js";

describe("formatTable", () => {
  it("formats rows as aligned columns", () => {
    const rows = [
      { name: "foo", value: "123" },
      { name: "longer-name", value: "4" },
    ];
    const output = formatTable(rows);
    expect(output).toContain("name");
    expect(output).toContain("value");
    expect(output).toContain("foo");
    expect(output).toContain("longer-name");
    expect(output).toContain("---");
  });

  it("returns no-data message for empty array", () => {
    expect(formatTable([])).toBe("(no data)\n");
  });

  it("respects explicit column selection", () => {
    const rows = [{ a: "1", b: "2", c: "3" }];
    const output = formatTable(rows, ["a", "c"]);
    expect(output).toContain("a");
    expect(output).toContain("c");
    expect(output).not.toContain("  b  ");
  });
});

describe("formatCsv", () => {
  it("formats rows as CSV with header", () => {
    const rows = [
      { name: "foo", value: "123" },
      { name: "bar", value: "456" },
    ];
    const output = formatCsv(rows);
    const lines = output.trim().split("\n");
    expect(lines[0]).toBe("name,value");
    expect(lines[1]).toBe("foo,123");
    expect(lines[2]).toBe("bar,456");
  });

  it("escapes values containing commas", () => {
    const rows = [{ text: "hello, world" }];
    const output = formatCsv(rows);
    expect(output).toContain('"hello, world"');
  });

  it("escapes values containing quotes", () => {
    const rows = [{ text: 'say "hello"' }];
    const output = formatCsv(rows);
    expect(output).toContain('"say ""hello"""');
  });

  it("returns empty string for empty array", () => {
    expect(formatCsv([])).toBe("");
  });
});

describe("resolveOutputFormat", () => {
  it("returns json when --json flag is set", () => {
    expect(resolveOutputFormat({ _: [], json: true })).toBe("json");
  });

  it("returns table when --output table", () => {
    expect(resolveOutputFormat({ _: [], output: "table" })).toBe("table");
  });

  it("returns csv when --output csv", () => {
    expect(resolveOutputFormat({ _: [], output: "csv" })).toBe("csv");
  });
});
