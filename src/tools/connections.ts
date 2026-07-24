import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callEdgeFunction } from '../lib/edge-function.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getDefaultProjectId, getDefaultUserId, resolveProjectStrict } from '../lib/supabase.js';

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
  effective_status?: string;
  username: string | null;
  created_at: string;
  project_id?: string | null;
  expires_at: string | null;
  has_refresh_token: boolean;
}

function findActiveAccounts(
  accounts: ConnectedAccountRow[],
  platform: Platform,
  projectId: string
): ConnectedAccountRow[] {
  const target = platform.toLowerCase();
  return accounts.filter(a => {
    const effectiveStatus = a.effective_status || a.status;
    return (
      a.platform.toLowerCase() === target &&
      a.project_id === projectId &&
      (effectiveStatus === 'active' || effectiveStatus === 'expires_soon')
    );
  });
}

// Cap concurrent in-flight `wait_for_connection` long-polls per user (see the
// handler below). Keyed by user ID; the entry is removed when the count hits 0.
const MAX_CONCURRENT_WAITS_PER_USER = 3;
const inFlightWaitsByUser = new Map<string, number>();

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
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Brand/project ID to bind the new social account to. Required when the account has multiple brands.'
        ),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Default: text.'),
    },
    async ({ platform, project_id, response_format }) => {
      const format = response_format ?? 'text';

      const userId = await getDefaultUserId();
      const rl = checkRateLimit('posting', `start_platform_connection:${userId}`);
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
      // Strict: starting a NEW connection must never auto-bind to whichever
      // project happens to already own an unrelated account (F1-followup,
      // 2026-07-15). Explicit project_id or a single-project key only.
      const projectResolution = await resolveProjectStrict(project_id);
      if (!projectResolution.projectId) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                projectResolution.error ??
                'A project_id is required to connect a platform. Configure an explicit project or use an API key scoped to exactly one project.',
            },
          ],
          isError: true,
        };
      }
      const resolvedProjectId = projectResolution.projectId;
      const projectAutoResolvedNote = projectResolution.autoResolvedNote;

      const { data, error } = await callEdgeFunction<{
        success: boolean;
        nonce: string;
        platform: string;
        expires_at: string;
        deep_link: string;
        project_id?: string;
        error?: string;
      }>(
        'mcp-data',
        {
          action: 'mint-connection-nonce',
          platform,
          projectId: resolvedProjectId,
          project_id: resolvedProjectId,
        },
        { timeoutMs: 10_000 }
      );

      if (error || !data?.success || !data.deep_link) {
        const errMsg = error ?? data?.error ?? 'Unknown error';
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
      if (data.project_id !== resolvedProjectId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Connection link project attestation failed. No OAuth link was returned.',
            },
          ],
          isError: true,
        };
      }

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  platform: data.platform,
                  project_id: resolvedProjectId,
                  deep_link: data.deep_link,
                  expires_at: data.expires_at,
                  next_step:
                    'Open deep_link in a browser, approve on the platform, then call wait_for_connection.',
                  ...(projectAutoResolvedNote
                    ? { project_auto_resolved: projectAutoResolvedNote }
                    : {}),
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
              `Brand/project: ${resolvedProjectId}`,
              '',
              'Ask the user to open this link in a browser and click "Connect" on the platform:',
              `  ${data.deep_link}`,
              '',
              `Link expires at: ${data.expires_at} (~2 minutes).`,
              '',
              'After they approve, call `wait_for_connection` with the same platform to confirm.',
              'This is a one-time browser setup — not another OAuth flow inside Claude.',
              ...(projectAutoResolvedNote ? ['', `Note: ${projectAutoResolvedNote}`] : []),
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
      project_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Brand/project ID to scope the connection poll. Use the same project_id passed to start_platform_connection.'
        ),
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
    async ({ platform, project_id, timeout_s, poll_interval_s, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      const timeoutMs = (timeout_s ?? 120) * 1000;
      const intervalMs = (poll_interval_s ?? 5) * 1000;
      const deadline = startedAt + timeoutMs;

      const userId = await getDefaultUserId();
      const rl = checkRateLimit('read', `wait_for_connection:${userId}`);
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
      const resolvedProjectId = project_id ?? (await getDefaultProjectId()) ?? undefined;
      if (!resolvedProjectId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'A project_id is required to wait for a connection. Use the same project_id used to start the OAuth flow.',
            },
          ],
          isError: true,
        };
      }

      // Bound how many long-polls a single user can hold open at once. Each wait
      // keeps a request open for up to timeout_s and calls the backend on every
      // poll, so without this cap one authenticated user could open many
      // concurrent waits and amplify one accepted call into a flood of backend
      // connected-accounts calls.
      const activeWaits = inFlightWaitsByUser.get(userId) ?? 0;
      if (activeWaits >= MAX_CONCURRENT_WAITS_PER_USER) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Too many concurrent \`wait_for_connection\` calls (max ${MAX_CONCURRENT_WAITS_PER_USER}). ` +
                'Let an existing wait finish, or poll `list_connected_accounts` instead.',
            },
          ],
          isError: true,
        };
      }
      inFlightWaitsByUser.set(userId, activeWaits + 1);

      try {
        let attempts = 0;
        while (Date.now() < deadline) {
          attempts++;
          const { data, error } = await callEdgeFunction<{
            success: boolean;
            accounts: ConnectedAccountRow[];
            error?: string;
          }>(
            'mcp-data',
            {
              action: 'connected-accounts',
              projectId: resolvedProjectId,
              project_id: resolvedProjectId,
            },
            { timeoutMs: 10_000 }
          );

          if (!error && data?.success) {
            const foundAccounts = findActiveAccounts(
              data.accounts ?? [],
              platform,
              resolvedProjectId
            );
            if (foundAccounts.length > 1) {
              // The OAuth flow succeeded — the platform IS connected, just to
              // more than one account on this project. That is success with a
              // choice to make, not a failure: the connection isn't broken,
              // the caller just needs to pick which account before publishing.
              // (F8, 2026-07-15 — this used to return isError:true, which
              // masked a successful connect behind an "error".)
              if (format === 'json') {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify(
                        {
                          connected: true,
                          platform,
                          project_id: resolvedProjectId,
                          accounts: foundAccounts.map(a => ({
                            id: a.id,
                            username: a.username,
                            connected_at: a.created_at,
                          })),
                          attempts,
                          message: `${platform} has ${foundAccounts.length} active accounts for this project. Pass the exact account_id to schedule_post.`,
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
                      `${platform} is connected — ${foundAccounts.length} active accounts found for project ${resolvedProjectId}:`,
                      ...foundAccounts.map(a => `  ${a.username || '(unnamed)'} (id=${a.id})`),
                      '',
                      'Call schedule_post with the exact account_id (or account_ids) for the one you mean.',
                    ].join('\n'),
                  },
                ],
                isError: false,
              };
            }
            const found = foundAccounts[0];
            if (found) {
              if (format === 'json') {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify(
                        {
                          connected: true,
                          platform: found.platform,
                          project_id: resolvedProjectId,
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
                      `Brand/project: ${resolvedProjectId}`,
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
                    project_id: resolvedProjectId,
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
      } finally {
        const remainingWaits = (inFlightWaitsByUser.get(userId) ?? 1) - 1;
        if (remainingWaits <= 0) {
          inFlightWaitsByUser.delete(userId);
        } else {
          inFlightWaitsByUser.set(userId, remainingWaits);
        }
      }
    }
  );
}
