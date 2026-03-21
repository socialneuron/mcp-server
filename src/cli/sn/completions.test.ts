import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCompletions } from "./completions.js";

describe("handleCompletions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("outputs bash completions", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await handleCompletions({ _: ["bash"] }, false);
    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toContain("_sn_completions");
    expect(output).toContain("complete -F");
    writeSpy.mockRestore();
  });

  it("outputs zsh completions", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await handleCompletions({ _: ["zsh"] }, false);
    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toContain("#compdef sn");
    expect(output).toContain("_sn");
    writeSpy.mockRestore();
  });

  it("shows help when no shell specified", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleCompletions({ _: [] }, false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    logSpy.mockRestore();
  });
});
