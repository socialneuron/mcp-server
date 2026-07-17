import { describe, it, expect, afterEach, vi } from "vitest";

const ORIGINAL_MAX_CREDITS = process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN;

/**
 * budget.ts reads SOCIALNEURON_MAX_CREDITS_PER_RUN once at module load, so each
 * test sets the env var, resets the module registry, then dynamically imports a
 * fresh copy — mirroring carousel.budget.test.ts.
 */
async function loadBudget(maxCredits?: string) {
  vi.resetModules();
  if (maxCredits === undefined) {
    delete process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN;
  } else {
    process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN = maxCredits;
  }
  return import("./budget.js");
}

describe("checkCreditBudget per-run cap", () => {
  afterEach(() => {
    if (ORIGINAL_MAX_CREDITS === undefined) {
      delete process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN;
    } else {
      process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN = ORIGINAL_MAX_CREDITS;
    }
    vi.resetModules();
  });

  it("is a no-op when the cap is unset", async () => {
    const { checkCreditBudget } = await loadBudget(undefined);
    expect(checkCreditBudget(9999)).toEqual({ ok: true });
  });

  it("allows a call that stays within the cap", async () => {
    const { checkCreditBudget } = await loadBudget("500");
    expect(checkCreditBudget(100)).toEqual({ ok: true });
  });

  it("blocks a call that exceeds the cap with a billing_error (NOT rate_limited)", async () => {
    const { checkCreditBudget } = await loadBudget("100");
    const result = checkCreditBudget(150);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected block");

    const errorType = result.error.structuredContent.error.error_type;
    expect(errorType).toBe("billing_error");
    expect(errorType).not.toBe("rate_limited");
    expect(result.error.isError).toBe(true);
  });

  it("names the env var, the run spend, the call cost, and the remedy", async () => {
    const { checkCreditBudget } = await loadBudget("100");
    const result = checkCreditBudget(150);
    if (result.ok) throw new Error("expected block");

    const { message } = result;
    expect(message).toContain("SOCIALNEURON_MAX_CREDITS_PER_RUN");
    expect(message).toContain("100"); // the cap
    expect(message).toContain("150"); // estimated call cost
    expect(message).toMatch(/raise or unset SOCIALNEURON_MAX_CREDITS_PER_RUN/i);
    // Must not carry rate-limit-style retry instructions (it explicitly
    // disclaims being a rate limit, but must not tell the caller to back off).
    expect(message).not.toMatch(/\b429\b|retry in|retry after|back off/i);
  });

  it("carries machine-readable billing details and recovery hints", async () => {
    const { checkCreditBudget } = await loadBudget("100");
    const result = checkCreditBudget(150);
    if (result.ok) throw new Error("expected block");

    const err = result.error.structuredContent.error;
    expect(err).toMatchObject({
      env_var: "SOCIALNEURON_MAX_CREDITS_PER_RUN",
      credits_used_this_run: 0,
      estimated_call_cost: 150,
      max_credits_per_run: 100,
    });
    expect(err.recover_with).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Unset SOCIALNEURON_MAX_CREDITS_PER_RUN"),
      ]),
    );
  });

  it("maps to HTTP 402 (billing), not 429 (rate limit), via httpStatusForResult", async () => {
    const { checkCreditBudget } = await loadBudget("100");
    const { httpStatusForResult } = await import("./rest-invoke.js");
    const result = checkCreditBudget(150);
    if (result.ok) throw new Error("expected block");

    expect(httpStatusForResult(result.error)).toBe(402);
    expect(httpStatusForResult(result.error)).not.toBe(429);
  });
});
