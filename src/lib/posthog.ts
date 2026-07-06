/**
 * PostHog analytics for MCP server tool invocations.
 *
 * Uses posthog-node (server-side SDK) to track tool usage patterns.
 * Respects DO_NOT_TRACK and SOCIALNEURON_NO_TELEMETRY env vars.
 */

import { createHash } from 'node:crypto';
import { PostHog } from 'posthog-node';
import { isTelemetryDisabled, getDefaultUserId } from './supabase.js';

// Hash userId before sending to PostHog to avoid PII leakage.
// Uses a static salt so the same user produces the same distinctId across sessions.
const POSTHOG_SALT = 'socialneuron-mcp-ph-v1';

function hashUserId(userId: string): string {
  return createHash('sha256').update(`${POSTHOG_SALT}:${userId}`).digest('hex').substring(0, 32);
}

let client: PostHog | null = null;

export function initPostHog(): void {
  if (isTelemetryDisabled()) return;

  const key = process.env.POSTHOG_KEY || process.env.VITE_POSTHOG_KEY;
  const host =
    process.env.POSTHOG_HOST || process.env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com';

  if (!key) return;

  client = new PostHog(key, { host, flushAt: 5, flushInterval: 10000 });
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
