/**
 * PostHog analytics for MCP server tool invocations.
 *
 * Telemetry is OFF by default. To opt in, set SOCIALNEURON_TELEMETRY=1.
 * DO_NOT_TRACK=1 always disables telemetry regardless of other settings.
 *
 * posthog-node is an optional dependency — if not installed, all functions
 * are silent no-ops.
 */

import { createHash } from 'node:crypto';
import { getDefaultUserId } from './supabase.js';

// Hash userId before sending to PostHog to avoid PII leakage.
// Uses a static salt so the same user produces the same distinctId across sessions.
const POSTHOG_SALT = 'socialneuron-mcp-ph-v1';

function hashUserId(userId: string): string {
  return createHash('sha256').update(`${POSTHOG_SALT}:${userId}`).digest('hex').substring(0, 32);
}

/**
 * Telemetry requires explicit opt-in via SOCIALNEURON_TELEMETRY=1.
 * DO_NOT_TRACK=1 or SOCIALNEURON_NO_TELEMETRY=1 always override to disable.
 */
function isTelemetryOptedIn(): boolean {
  if (
    process.env.DO_NOT_TRACK === '1' ||
    process.env.DO_NOT_TRACK === 'true' ||
    process.env.SOCIALNEURON_NO_TELEMETRY === '1'
  ) {
    return false;
  }
  return process.env.SOCIALNEURON_TELEMETRY === '1';
}

// Using `any` here because posthog-node may not be installed and we
// cannot reference its types at compile time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any = null;

export function initPostHog(): void {
  if (!isTelemetryOptedIn()) return;

  const key = process.env.POSTHOG_KEY || process.env.VITE_POSTHOG_KEY;
  const host =
    process.env.POSTHOG_HOST || process.env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com';

  if (!key) return;

  // Dynamic import — if posthog-node is not installed, silently skip.
  import('posthog-node')
    .then(({ PostHog }) => {
      client = new PostHog(key, { host, flushAt: 5, flushInterval: 10000 });
    })
    .catch(() => {
      // posthog-node not installed — telemetry will be a no-op.
    });
}

export async function captureToolEvent(args: {
  toolName: string;
  status: 'success' | 'error' | 'rate_limited';
  durationMs: number;
  details?: Record<string, unknown>;
}): Promise<void> {
  if (!client) return;

  let userId: string;
  try {
    userId = await getDefaultUserId();
  } catch {
    userId = 'anonymous_mcp';
  }

  client.capture({
    distinctId: hashUserId(userId),
    event: `mcp_tool_${args.status}`,
    properties: {
      tool_name: args.toolName,
      duration_ms: args.durationMs,
      ...args.details,
    },
  });
}

export async function shutdownPostHog(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
  }
}
