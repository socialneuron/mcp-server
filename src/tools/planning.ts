import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { callEdgeFunction } from '../lib/edge-function.js';
import { sanitizeError } from '../lib/sanitize-error.js';
import { logMcpToolInvocation, getDefaultProjectId } from '../lib/supabase.js';
import type {
  ContentPlan,
  ContentPlanPost,
  IdeationContext,
  Platform,
  ResponseEnvelope,
} from '../types/index.js';
import { MCP_VERSION } from '../lib/version.js';
import { extractJsonArray } from '../lib/parse-utils.js';

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return { _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() }, data };
}

function tomorrowIsoDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function addDaysToIsoDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function isYouTubeUrl(url: string): boolean {
  return /youtube\.com\/watch|youtu\.be\/|youtube\.com\/@/.test(url);
}

function formatPlanAsText(plan: ContentPlan): string {
  const lines: string[] = [];
  lines.push(`WEEKLY CONTENT PLAN: "${plan.topic}"`);
  lines.push(`Period: ${plan.start_date} to ${plan.end_date}`);
  lines.push(`Platforms: ${plan.platforms.join(', ')}`);
  lines.push(`Posts: ${plan.posts.length} | Estimated credits: ~${plan.estimated_credits}`);
  if (plan.plan_id) lines.push(`Plan ID: ${plan.plan_id}`);
  if (plan.insights_applied?.has_historical_data) {
    lines.push('');
    lines.push('What the AI learned from your data:');
    if (plan.insights_applied.top_hooks.length > 0) {
      lines.push(`- Top hooks: ${plan.insights_applied.top_hooks.join(', ')}`);
    }
    const timing = plan.insights_applied.optimal_timing;
    if (timing) {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      lines.push(
        `- Best posting time: ${days[timing.dayOfWeek] ?? timing.dayOfWeek} ${timing.hourOfDay}:00`
      );
    }
    lines.push(`- Recommended model: ${plan.insights_applied.recommended_model ?? 'N/A'}`);
    lines.push(`- Insights count: ${plan.insights_applied.insights_count}`);
  }
  lines.push('');

  const byDay = new Map<number, ContentPlanPost[]>();
  for (const post of plan.posts) {
    const day = post.day ?? 1;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(post);
  }

  for (const [day, posts] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const date = posts[0]?.date ?? '';
    lines.push(`--- Day ${day} (${date}) ---`);
    for (const post of posts) {
      lines.push(`  [${post.platform.toUpperCase()}] ${post.content_type}`);
      lines.push(`  Hook: ${post.hook}`);
      lines.push(`  Angle: ${post.angle}`);
      lines.push(
        `  Caption: ${post.caption.slice(0, 200)}${post.caption.length > 200 ? '...' : ''}`
      );
      if (post.title) lines.push(`  Title: ${post.title}`);
      if (post.visual_direction) lines.push(`  Visual: ${post.visual_direction}`);
      if (post.media_type) lines.push(`  Media: ${post.media_type}`);
      if (post.hashtags?.length) lines.push(`  Hashtags: ${post.hashtags.join(' ')}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function registerPlanningTools(server: McpServer): void {
  server.tool(
    'plan_content_week',
    'Generate a full content plan with platform-specific drafts, hooks, angles, and optimal schedule times. Pass a topic or source_url — brand context and performance insights auto-load via project_id. Output feeds directly into quality_check_plan then schedule_content_plan. Costs ~5-15 credits depending on post count.',
    {
      topic: z.string().describe('Main topic or content theme'),
      source_url: z.string().optional().describe('URL to extract content from (YouTube, article)'),
      platforms: z
        .array(
          z.enum([
            'youtube',
            'tiktok',
            'instagram',
            'twitter',
            'linkedin',
            'facebook',
            'threads',
            'bluesky',
          ])
        )
        .min(1)
        .describe('Target platforms'),
      posts_per_day: z.number().min(1).max(5).default(1).describe('Posts per platform per day'),
      days: z.number().min(1).max(7).default(5).describe('Number of days to plan'),
      start_date: z.string().optional().describe('ISO date, defaults to tomorrow'),
      brand_voice: z.string().optional().describe('Override brand voice description'),
      project_id: z.string().optional().describe('Project ID for brand/insights context'),
      response_format: z.enum(['text', 'json']).default('json'),
    },
    async ({
      topic,
      source_url,
      platforms,
      posts_per_day,
      days,
      start_date,
      brand_voice,
      project_id,
      response_format,
    }) => {
      const startedAt = Date.now();
      const planId = randomUUID();
      const resolvedStartDate = start_date ?? tomorrowIsoDate();
      const endDate = addDaysToIsoDate(resolvedStartDate, days - 1);
      let resolvedProjectId = project_id;

      try {
        if (!resolvedProjectId) {
          resolvedProjectId = (await getDefaultProjectId()) ?? undefined;
        }
        // Step 1: Extract source content (non-fatal)
        let sourceContext = '';
        if (source_url) {
          try {
            const fnName = isYouTubeUrl(source_url) ? 'scrape-youtube' : 'fetch-url-content';
            const { data } = await callEdgeFunction<Record<string, unknown>>(
              fnName,
              { url: source_url },
              { timeoutMs: 30_000 }
            );
            if (data) {
              const parts = [
                data.title ? String(data.title) : '',
                data.description ? String(data.description) : '',
                data.transcript ? String(data.transcript).slice(0, 2000) : '',
                data.content ? String(data.content).slice(0, 2000) : '',
              ].filter(Boolean);
              sourceContext = parts.join('\n\n');
            }
          } catch {
            // Non-fatal — continue without source context
          }
        }

        // Step 2: Load brand profile (non-fatal)
        let brandName = '';
        let brandContext = '';
        let ideationContext: IdeationContext | null = null;
        let loopSummary: Record<string, unknown> | null = null;
        if (!brand_voice) {
          try {
            const { data } = await callEdgeFunction<{
              success?: boolean;
              profile?: Record<string, unknown> | null;
            }>(
              'mcp-data',
              {
                action: 'brand-profile',
                ...(resolvedProjectId
                  ? { projectId: resolvedProjectId, project_id: resolvedProjectId }
                  : {}),
              },
              { timeoutMs: 15_000 }
            );

            const profile = data?.profile;
            if (profile) {
              const ctx = (profile.brand_context as Record<string, unknown> | undefined) ?? {};
              brandName = String(profile.brand_name ?? ctx.name ?? '');

              const voiceProfile = (ctx.voiceProfile as Record<string, unknown> | undefined) ?? {};
              const tone =
                Array.isArray(voiceProfile.tone) && voiceProfile.tone.length > 0
                  ? voiceProfile.tone.map(String).join(', ')
                  : String(profile.voice_tone ?? '');
              const targetAudience =
                (ctx.targetAudience as Record<string, unknown> | undefined) ?? undefined;
              const psycho =
                (targetAudience?.psychographics as Record<string, unknown> | undefined) ??
                undefined;
              const painPoints = Array.isArray(psycho?.painPoints)
                ? psycho.painPoints.map(String).join(', ')
                : '';
              const audience = painPoints || String(profile.audience ?? '');

              brandContext = [brandName, tone, audience].filter(Boolean).join(' — ');
            }
          } catch {
            // Non-fatal
          }
        }

        // Step 2b: Load feedback-loop context (non-fatal)
        if (resolvedProjectId) {
          try {
            const [{ data: ideationData }, { data: loopData }] = await Promise.all([
              callEdgeFunction<{ success?: boolean; context?: IdeationContext }>(
                'mcp-data',
                {
                  action: 'ideation-context',
                  projectId: resolvedProjectId,
                  project_id: resolvedProjectId,
                  days: 30,
                },
                { timeoutMs: 20_000 }
              ),
              callEdgeFunction<{ success?: boolean; summary?: Record<string, unknown> }>(
                'mcp-data',
                {
                  action: 'loop-summary',
                  projectId: resolvedProjectId,
                  project_id: resolvedProjectId,
                },
                { timeoutMs: 20_000 }
              ),
            ]);
            ideationContext = ideationData?.context ?? null;
            loopSummary = loopData?.summary ?? null;
          } catch {
            // Non-fatal
          }
        }

        // Step 3: Build prompt
        const promptParts = [
          `Generate a ${days}-day content plan for "${topic}" across platforms: ${platforms.join(', ')}.`,
          `${posts_per_day} post(s) per platform per day. Start date: ${resolvedStartDate}.`,
          sourceContext ? `\nSource material:\n${sourceContext}\n` : '',
          brandContext ? `Brand context: ${brandContext}` : '',
          brand_voice ? `Brand voice override: ${brand_voice}` : '',
          ideationContext?.promptInjection
            ? `Performance insights:\n${ideationContext.promptInjection.slice(0, 1500)}`
            : '',
          '',
          'For each post, return a JSON object with these fields:',
          '  id (format: "day{N}-{platform}-{index}", e.g. "day1-linkedin-1")',
          '  day (number, 1-' + days + ')',
          '  date (ISO date)',
          '  platform (lowercase)',
          '  content_type ("script", "caption", "blog", or "hook")',
          '  caption (full post text, platform-appropriate length)',
          '  title (for YouTube/LinkedIn articles)',
          '  hashtags (array of strings)',
          '  hook (attention-grabbing first line)',
          '  angle (unique perspective/approach)',
          '  visual_direction (what image/video should show)',
          '  media_type ("image", "video", "carousel", or "text-only")',
          '',
          'Return ONLY a JSON array of post objects. No surrounding text.',
        ];

        const prompt = promptParts.filter(Boolean).join('\n');

        // Step 4: Call AI
        const { data: aiData, error: aiError } = await callEdgeFunction<{
          text?: string;
          content?: string;
        }>(
          'social-neuron-ai',
          {
            type: 'generation',
            prompt,
            model: 'gemini-2.5-flash',
            responseFormat: 'json',
            ...(resolvedProjectId
              ? { projectId: resolvedProjectId, project_id: resolvedProjectId }
              : {}),
          },
          { timeoutMs: 60_000 }
        );

        if (aiError || !aiData) {
          const durationMs = Date.now() - startedAt;
          logMcpToolInvocation({
            toolName: 'plan_content_week',
            status: 'error',
            durationMs,
            details: { topic, error: aiError },
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: `Plan generation failed: ${aiError ?? 'No response from AI'}`,
              },
            ],
            isError: true,
          };
        }

        // Step 5: Parse AI response
        const rawText = String(aiData.text ?? aiData.content ?? '');
        const postsArray = extractJsonArray(rawText);

        if (!postsArray) {
          const durationMs = Date.now() - startedAt;
          logMcpToolInvocation({
            toolName: 'plan_content_week',
            status: 'error',
            durationMs,
            details: { topic, error: 'could not parse AI response' },
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: `AI response could not be parsed as JSON.\n\nRaw output (first 1000 chars):\n${rawText.slice(0, 1000)}`,
              },
            ],
            isError: true,
          };
        }

        // Step 6: Build ContentPlan
        const posts: ContentPlanPost[] = postsArray.map((p: any) => ({
          id: String(p.id ?? ''),
          day: Number(p.day ?? 1),
          date: String(p.date ?? resolvedStartDate),
          platform: String(p.platform ?? '') as Platform,
          content_type: (p.content_type ?? 'caption') as ContentPlanPost['content_type'],
          caption: String(p.caption ?? ''),
          title: p.title ? String(p.title) : undefined,
          hashtags: Array.isArray(p.hashtags) ? p.hashtags.map(String) : undefined,
          hook: String(p.hook ?? ''),
          angle: String(p.angle ?? ''),
          visual_direction: p.visual_direction ? String(p.visual_direction) : undefined,
          media_type: p.media_type
            ? (String(p.media_type) as ContentPlanPost['media_type'])
            : undefined,
        }));

        const insightsApplied: NonNullable<ContentPlan['insights_applied']> = {
          top_hooks: ideationContext?.topHooks?.slice(0, 3) ?? [],
          optimal_timing: ideationContext?.recommendedPostingTime
            ? {
                dayOfWeek: ideationContext.recommendedPostingTime.dayOfWeek,
                hourOfDay: ideationContext.recommendedPostingTime.hourOfDay,
                timezone: ideationContext.recommendedPostingTime.timezone,
              }
            : null,
          recommended_model: ideationContext?.recommendedModel ?? null,
          winning_patterns: ideationContext?.winningPatterns ?? {
            hookTypes: [],
            contentFormats: [],
            ctaStyles: [],
          },
          insights_count: ideationContext?.insightsCount ?? 0,
          has_historical_data: ideationContext?.hasHistoricalData ?? false,
        };

        const plan: ContentPlan = {
          plan_id: planId,
          generated_at: new Date().toISOString(),
          topic,
          source_url,
          brand_name: brandName || undefined,
          project_id: resolvedProjectId,
          start_date: resolvedStartDate,
          end_date: endDate,
          platforms: platforms as Platform[],
          estimated_credits: 15 + (source_url ? 5 : 0),
          posts,
          context_used: {
            ideation_context: toRecord(ideationContext),
            loop_summary: toRecord(loopSummary),
            project_id: resolvedProjectId,
          },
          insights_applied: insightsApplied,
        };

        // Step 7: Persist content plan when project context is available
        if (resolvedProjectId) {
          try {
            const { error: persistError } = await callEdgeFunction(
              'mcp-data',
              {
                action: 'save-content-plan',
                plan_id: planId,
                projectId: resolvedProjectId,
                project_id: resolvedProjectId,
                topic,
                plan_status: 'draft',
                plan_payload: plan,
                insights_applied: insightsApplied,
                source: 'mcp',
              },
              { timeoutMs: 10_000 }
            );
            if (persistError) {
              throw new Error(persistError);
            }
          } catch (persistErr) {
            const durationMs = Date.now() - startedAt;
            const message = sanitizeError(persistErr);
            logMcpToolInvocation({
              toolName: 'plan_content_week',
              status: 'error',
              durationMs,
              details: { topic, error: `plan persistence failed: ${message}` },
            });
            return {
              content: [{ type: 'text' as const, text: `Plan persistence failed: ${message}` }],
              isError: true,
            };
          }
        }

        const durationMs = Date.now() - startedAt;
        logMcpToolInvocation({
          toolName: 'plan_content_week',
          status: 'success',
          durationMs,
          details: { topic, platforms, posts: posts.length, days },
        });

        if (response_format === 'json') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(plan), null, 2) }],
            isError: false,
          };
        }

        return {
          content: [{ type: 'text' as const, text: formatPlanAsText(plan) }],
          isError: false,
        };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = sanitizeError(err);
        logMcpToolInvocation({
          toolName: 'plan_content_week',
          status: 'error',
          durationMs,
          details: { topic, error: message },
        });
        return {
          content: [{ type: 'text' as const, text: `Plan generation failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'save_content_plan',
    'Save a content plan to the database for team review, approval workflows, and scheduled publishing. Creates a plan_id you can reference in get_content_plan, update_content_plan, and schedule_content_plan.',
    {
      plan: z
        .object({
          topic: z.string(),
          posts: z.array(z.record(z.string(), z.unknown())),
        })
        .passthrough(),
      project_id: z.string().uuid().optional(),
      status: z.enum(['draft', 'in_review', 'approved', 'scheduled', 'completed']).default('draft'),
      response_format: z.enum(['text', 'json']).default('json'),
    },
    async ({ plan, project_id, status, response_format }) => {
      const startedAt = Date.now();
      try {
        const normalizedStatus = status ?? 'draft';
        const resolvedProjectId =
          project_id ||
          (typeof plan.project_id === 'string' ? plan.project_id : null) ||
          (await getDefaultProjectId());

        if (!resolvedProjectId) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No project_id provided and no default project found.',
              },
            ],
            isError: true,
          };
        }

        const planId =
          typeof plan.plan_id === 'string' && plan.plan_id ? plan.plan_id : randomUUID();
        const payload: ContentPlan = {
          ...(plan as unknown as ContentPlan),
          plan_id: planId,
          project_id: resolvedProjectId,
        };

        const { error } = await callEdgeFunction(
          'mcp-data',
          {
            action: 'save-content-plan',
            plan_id: planId,
            projectId: resolvedProjectId,
            project_id: resolvedProjectId,
            topic: payload.topic || 'Untitled Plan',
            plan_status: normalizedStatus,
            plan_payload: payload,
            insights_applied: payload.insights_applied ?? null,
            source: 'mcp',
          },
          { timeoutMs: 10_000 }
        );

        if (error) {
          throw new Error(error);
        }

        const durationMs = Date.now() - startedAt;
        logMcpToolInvocation({
          toolName: 'save_content_plan',
          status: 'success',
          durationMs,
          details: { plan_id: planId, project_id: resolvedProjectId, status: normalizedStatus },
        });

        const result = {
          plan_id: planId,
          project_id: resolvedProjectId,
          status: normalizedStatus,
        };

        if (response_format === 'json') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(result), null, 2) }],
            isError: false,
          };
        }

        return {
          content: [
            { type: 'text' as const, text: `Saved content plan ${planId} (${normalizedStatus}).` },
          ],
          isError: false,
        };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = sanitizeError(err);
        logMcpToolInvocation({
          toolName: 'save_content_plan',
          status: 'error',
          durationMs,
          details: { error: message },
        });
        return {
          content: [{ type: 'text' as const, text: `Failed to save content plan: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_content_plan',
    'Retrieve a persisted content plan by ID.',
    {
      plan_id: z.string().uuid().describe('Persisted content plan ID'),
      response_format: z.enum(['text', 'json']).default('json'),
    },
    async ({ plan_id, response_format }) => {
      const { data: result, error } = await callEdgeFunction<{
        success: boolean;
        plan: {
          id: string;
          topic: string;
          status: string;
          plan_payload: ContentPlan;
          insights_applied: Record<string, unknown> | null;
          created_at: string;
          updated_at: string;
        } | null;
      }>('mcp-data', { action: 'get-content-plan', plan_id }, { timeoutMs: 10_000 });

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to load content plan: ${error}`,
            },
          ],
          isError: true,
        };
      }

      const data = result?.plan;
      if (!data) {
        return {
          content: [
            { type: 'text' as const, text: `No content plan found for plan_id=${plan_id}` },
          ],
          isError: true,
        };
      }

      const payload = {
        plan_id: data.id,
        topic: data.topic,
        status: data.status,
        created_at: data.created_at,
        updated_at: data.updated_at,
        insights_applied: data.insights_applied,
        plan: data.plan_payload,
      };

      if (response_format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
          isError: false,
        };
      }

      const plan = data.plan_payload as ContentPlan;
      const lines = [
        `Content Plan ${data.id}`,
        `Topic: ${data.topic}`,
        `Status: ${data.status}`,
        `Posts: ${Array.isArray(plan?.posts) ? plan.posts.length : 0}`,
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
    }
  );

  server.tool(
    'update_content_plan',
    'Update individual posts in a persisted content plan.',
    {
      plan_id: z.string().uuid(),
      post_updates: z
        .array(
          z.object({
            post_id: z.string(),
            caption: z.string().optional(),
            title: z.string().optional(),
            hashtags: z.array(z.string()).optional(),
            hook: z.string().optional(),
            angle: z.string().optional(),
            visual_direction: z.string().optional(),
            media_url: z.string().optional(),
            schedule_at: z.string().optional(),
            platform: z.string().optional(),
            status: z.enum(['approved', 'rejected', 'needs_edit']).optional(),
          })
        )
        .min(1),
      response_format: z.enum(['text', 'json']).default('json'),
    },
    async ({ plan_id, post_updates, response_format }) => {
      const { data: result, error } = await callEdgeFunction<{
        success: boolean;
        plan_id: string;
        status: string;
        updated_posts: number;
        error?: string;
      }>(
        'mcp-data',
        {
          action: 'update-content-plan',
          plan_id,
          post_updates,
        },
        { timeoutMs: 10_000 }
      );

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to update content plan: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!result?.success) {
        return {
          content: [
            { type: 'text' as const, text: `No content plan found for plan_id=${plan_id}` },
          ],
          isError: true,
        };
      }

      const payload = {
        plan_id,
        status: result.status,
        updated_posts: result.updated_posts,
      };

      if (response_format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
          isError: false,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated ${post_updates.length} post(s) in plan ${plan_id}.`,
          },
        ],
        isError: false,
      };
    }
  );

  server.tool(
    'submit_content_plan_for_approval',
    'Create pending approval items for each post in a plan and mark plan status as in_review.',
    {
      plan_id: z.string().uuid(),
      response_format: z.enum(['text', 'json']).default('json'),
    },
    async ({ plan_id, response_format }) => {
      const { data: result, error } = await callEdgeFunction<{
        success: boolean;
        plan_id: string;
        approvals_created: number;
        status: string;
        error?: string;
      }>('mcp-data', { action: 'submit-plan-approval', plan_id }, { timeoutMs: 15_000 });

      if (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to submit plan for approval: ${error}`,
            },
          ],
          isError: true,
        };
      }

      if (!result?.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: result?.error ?? `Plan ${plan_id} not found or has no posts.`,
            },
          ],
          isError: true,
        };
      }

      const payload = {
        plan_id,
        approvals_created: result.approvals_created,
        status: 'in_review',
      };

      if (response_format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(payload), null, 2) }],
          isError: false,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Submitted plan ${plan_id} for approval with ${payload.approvals_created} item(s).`,
          },
        ],
        isError: false,
      };
    }
  );
}
