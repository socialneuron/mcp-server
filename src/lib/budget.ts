import { requestContext } from "./request-context.js";
import { toolError, type ToolErrorResult } from "./tool-error.js";

const MAX_CREDITS_PER_RUN = Math.max(
  0,
  Number(process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN || 0),
);
const MAX_ASSETS_PER_RUN = Math.max(
  0,
  Number(process.env.SOCIALNEURON_MAX_ASSETS_PER_RUN || 0),
);

// Stdio-mode globals (single-user process — one budget per process lifetime)
let _globalCreditsUsed = 0;
let _globalAssetsGenerated = 0;

function getCreditsUsed(): number {
  const ctx = requestContext.getStore();
  return ctx ? ctx.creditsUsed : _globalCreditsUsed;
}

export function addCreditsUsed(amount: number): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.creditsUsed += amount;
  } else {
    _globalCreditsUsed += amount;
  }
}

function getAssetsGenerated(): number {
  const ctx = requestContext.getStore();
  return ctx ? ctx.assetsGenerated : _globalAssetsGenerated;
}

export function addAssetsGenerated(count: number): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.assetsGenerated += count;
  } else {
    _globalAssetsGenerated += count;
  }
}

export function getCurrentBudgetStatus(): {
  creditsUsedThisRun: number;
  maxCreditsPerRun: number;
  remaining: number | null;
  assetsGeneratedThisRun: number;
  maxAssetsPerRun: number;
  remainingAssets: number | null;
} {
  const creditsUsed = getCreditsUsed();
  const assetsGen = getAssetsGenerated();
  return {
    creditsUsedThisRun: creditsUsed,
    maxCreditsPerRun: MAX_CREDITS_PER_RUN,
    remaining:
      MAX_CREDITS_PER_RUN > 0
        ? Math.max(0, MAX_CREDITS_PER_RUN - creditsUsed)
        : null,
    assetsGeneratedThisRun: assetsGen,
    maxAssetsPerRun: MAX_ASSETS_PER_RUN,
    remainingAssets:
      MAX_ASSETS_PER_RUN > 0
        ? Math.max(0, MAX_ASSETS_PER_RUN - assetsGen)
        : null,
  };
}

export function checkCreditBudget(
  estimatedCost: number,
): { ok: true } | { ok: false; message: string; error: ToolErrorResult } {
  if (MAX_CREDITS_PER_RUN <= 0) {
    return { ok: true };
  }
  const used = getCreditsUsed();
  if (used + estimatedCost > MAX_CREDITS_PER_RUN) {
    // Deliberately NOT a rate-limit shape: this is a local, per-process spend
    // guard, not a server throttle. Retrying without changing the cap will loop
    // forever, so we classify it billing_error (HTTP 402) — never rate_limited
    // (429) — and spell out the env var, the running spend, and the remedy.
    const message =
      `Per-run credit cap reached — this is a local spend guard, not a server rate limit, so retrying will not help. ` +
      `The SOCIALNEURON_MAX_CREDITS_PER_RUN environment variable is set to ${MAX_CREDITS_PER_RUN} credits. ` +
      `This run has already spent ${used} credits and this call is estimated at ~${estimatedCost} more ` +
      `(${used} + ${estimatedCost} = ${used + estimatedCost} > ${MAX_CREDITS_PER_RUN}). ` +
      `To proceed, raise or unset SOCIALNEURON_MAX_CREDITS_PER_RUN.`;
    return {
      ok: false,
      message,
      error: toolError("billing_error", message, {
        recover_with: [
          "Raise SOCIALNEURON_MAX_CREDITS_PER_RUN to a higher credit ceiling.",
          "Unset SOCIALNEURON_MAX_CREDITS_PER_RUN to remove the per-run cap.",
        ],
        details: {
          env_var: "SOCIALNEURON_MAX_CREDITS_PER_RUN",
          credits_used_this_run: used,
          estimated_call_cost: estimatedCost,
          max_credits_per_run: MAX_CREDITS_PER_RUN,
        },
      }),
    };
  }
  return { ok: true };
}

export function checkAssetBudget(
  requestedCount = 1,
): { ok: true } | { ok: false; message: string } {
  if (MAX_ASSETS_PER_RUN <= 0) {
    return { ok: true };
  }
  const generated = getAssetsGenerated();
  if (generated + requestedCount > MAX_ASSETS_PER_RUN) {
    return {
      ok: false,
      message:
        `Asset budget exceeded for this MCP run. ` +
        `Generated=${generated}, next=${requestedCount}, limit=${MAX_ASSETS_PER_RUN}.`,
    };
  }
  return { ok: true };
}
