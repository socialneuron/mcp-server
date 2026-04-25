import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { logMcpToolInvocation } from '../lib/supabase.js';

const PLATFORM_ENUM = [
  'youtube',
  'tiktok',
  'instagram',
  'twitter',
  'linkedin',
  'facebook',
  'threads',
  'bluesky',
  'shopify',
  'etsy',
] as const;

type Platform = (typeof PLATFORM_ENUM)[number];

interface ConnectedAccountRow {
  id: string;
  platform: string;
  status: string;
  username: string | null;
  created_at: string;
  expires_at: string | null;
  has_refresh_token: boolean;
}

function findActiveAccount(
  accounts: ConnectedAccountRow[],
  platform: Platform
): ConnectedAccountRow | null {
  const target = platform.toLowerCase();
  return accounts.find(a => a.platform.toLowerCase() === target && a.status === 'active') ?? null;
}

export function registerConnectionTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // start_platform_connection — mint a single-use deep link the user clicks
  // to complete platform OAuth in their browser.
  // ---------------------------------------------------------------------------
  server.tool(
    'start_platform_connection',
    'Begin connecting a social platform (Instagram, TikTok, YouTube, etc.). Returns a single-use ' +
      'deep link the user opens in a browser to complete the one-time OAuth handshake on ' +
      'socialneuron.com. This is NOT another OAuth in Claude — platform connections require a ' +
      'browser session because the social platforms (Meta, Google, TikTok) only accept callbacks ' +
      'on socialneuron.com. After the user clicks the link and approves on the platform, call ' +
      '`wait_for_connection` to detect completion. Link expires in 2 minutes; mint a new one if ' +
      'needed. Use `list_connected_accounts` first to check whether the platform is already ' +
      'connected before calling this.',
    {
      platform: z
        .enum(PLATFORM_ENUM)
        .describe('Platform to connect. Lower-case: instagram, tiktok, youtube, etc.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Default: text.'),
    },
    async ({ platform, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();

      const rl = checkRateLimit('read', `start_platform_connection:${platform}`);
      if (!rl.allowed) {
        await logMcpToolInvocation({
          toolName: 'start_platform_connection',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rl.retryAfter, platform },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rl.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<{
        success: boolean;
        nonce: string;
        platform: string;
        expires_at: string;
        deep_link: string;
        error?: string;
      }>('mcp-data', { action: 'mint-connection-nonce', platform }, { timeoutMs: 10_000 });

      if (error || !data?.success || !data.deep_link) {
        const errMsg = error ?? data?.error ?? 'Unknown error';
        await logMcpToolInvocation({
          toolName: 'start_platform_connection',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: errMsg, platform },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to start ${platform} connection: ${errMsg}`,
            },
          ],
          isError: true,
        };
      }

      await logMcpToolInvocation({
        toolName: 'start_platform_connection',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: { platform: data.platform, expires_at: data.expires_at },
      });

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  platform: data.platform,
                  deep_link: data.deep_link,
                  expires_at: data.expires_at,
                  next_step:
                    'Open deep_link in a browser, approve on the platform, then call wait_for_connection.',
                },
                null,
                2
              ),
            },
          ],
          isError: false,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `${data.platform} connection ready.`,
              '',
              'Ask the user to open this link in a browser and click "Connect" on the platform:',
              `  ${data.deep_link}`,
              '',
              `Link expires at: ${data.expires_at} (~2 minutes).`,
              '',
              'After they approve, call `wait_for_connection` with the same platform to confirm.',
              'This is a one-time browser setup — not another OAuth flow inside Claude.',
            ].join('\n'),
          },
        ],
        isError: false,
      };
    }
  );

  // ---------------------------------------------------------------------------
  // wait_for_connection — poll connected_accounts until the platform shows up
  // active or timeout.
  // ---------------------------------------------------------------------------
  server.tool(
    'wait_for_connection',
    'Poll until a platform connection becomes active. Use after `start_platform_connection` ' +
      'while the user completes the browser OAuth flow. Returns when the account row appears ' +
      'with status=active, or when the timeout elapses. Default timeout 120s, max 600s.',
    {
      platform: z.enum(PLATFORM_ENUM).describe('Platform to wait for.'),
      timeout_s: z
        .number()
        .min(5)
        .max(600)
        .optional()
        .describe('How long to wait, in seconds. Default 120.'),
      poll_interval_s: z
        .number()
        .min(2)
        .max(30)
        .optional()
        .describe('Poll interval in seconds. Default 5.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Default: text.'),
    },
    async ({ platform, timeout_s, poll_interval_s, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      const timeoutMs = (timeout_s ?? 120) * 1000;
      const intervalMs = (poll_interval_s ?? 5) * 1000;
      const deadline = startedAt + timeoutMs;

      const rl = checkRateLimit('read', `wait_for_connection:${platform}`);
      if (!rl.allowed) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rl.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      let attempts = 0;
      while (Date.now() < deadline) {
        attempts++;
        const { data, error } = await callEdgeFunction<{
          success: boolean;
          accounts: ConnectedAccountRow[];
          error?: string;
        }>('mcp-data', { action: 'connected-accounts' }, { timeoutMs: 10_000 });

        if (!error && data?.success) {
          const found = findActiveAccount(data.accounts ?? [], platform);
          if (found) {
            await logMcpToolInvocation({
              toolName: 'wait_for_connection',
              status: 'success',
              durationMs: Date.now() - startedAt,
              details: { platform, attempts, found: true },
            });

            if (format === 'json') {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify(
                      {
                        connected: true,
                        platform: found.platform,
                        account_id: found.id,
                        username: found.username,
                        connected_at: found.created_at,
                        attempts,
                      },
                      null,
                      2
                    ),
                  },
                ],
                isError: false,
              };
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: [
                    `${found.platform} is connected.`,
                    `Account: ${found.username || '(unnamed)'} (id=${found.id})`,
                    `Detected after ${attempts} poll(s) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
                    'Ready to call `schedule_post`.',
                  ].join('\n'),
                },
              ],
              isError: false,
            };
          }
        }

        // Wait before next poll, but never sleep past the deadline.
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
      }

      await logMcpToolInvocation({
        toolName: 'wait_for_connection',
        status: 'error',
        durationMs: Date.now() - startedAt,
        details: { platform, attempts, found: false, reason: 'timeout' },
      });

      const message =
        `${platform} did not connect within ${timeout_s ?? 120}s (${attempts} polls). ` +
        'The user may not have completed the browser OAuth yet, or the link expired. ' +
        'Mint a new link with `start_platform_connection` and try again, or have the user ' +
        'go directly to socialneuron.com/settings/connections.';

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  connected: false,
                  platform,
                  attempts,
                  timed_out: true,
                  message,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: message }],
        isError: true,
      };
    }
  );
}
