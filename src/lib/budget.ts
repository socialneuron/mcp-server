import { requestContext } from './request-context.js';

const MAX_CREDITS_PER_RUN = Math.max(0, Number(process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN || 0));
const MAX_ASSETS_PER_RUN = Math.max(0, Number(process.env.SOCIALNEURON_MAX_ASSETS_PER_RUN || 0));

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
    remaining: MAX_CREDITS_PER_RUN > 0 ? Math.max(0, MAX_CREDITS_PER_RUN - creditsUsed) : null,
    assetsGeneratedThisRun: assetsGen,
    maxAssetsPerRun: MAX_ASSETS_PER_RUN,
    remainingAssets: MAX_ASSETS_PER_RUN > 0 ? Math.max(0, MAX_ASSETS_PER_RUN - assetsGen) : null,
  };
}

export function checkCreditBudget(
  estimatedCost: number
): { ok: true } | { ok: false; message: string } {
  if (MAX_CREDITS_PER_RUN <= 0) {
    return { ok: true };
  }
  const used = getCreditsUsed();
  if (used + estimatedCost > MAX_CREDITS_PER_RUN) {
    return {
      ok: false,
      message:
        `Credit budget exceeded for this MCP run. ` +
        `Used=${used}, next~=${estimatedCost}, limit=${MAX_CREDITS_PER_RUN}.`,
    };
  }
  return { ok: true };
}

export function checkAssetBudget(
  requestedCount = 1
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
