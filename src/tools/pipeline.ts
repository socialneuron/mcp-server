import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { callEdgeFunction } from '../lib/edge-function.js';
import { logMcpToolInvocation, getDefaultUserId, getDefaultProjectId } from '../lib/supabase.js';
import { evaluateQuality } from '../lib/quality.js';
import { MCP_VERSION } from '../lib/version.js';
import { extractJsonArray } from '../lib/parse-utils.js';
import type {
  ResponseEnvelope,
  PipelineReadinessCheck,
  ContentPlanPost,
  Platform,
} from '../types/index.js';

function asEnvelope<T>(data: T): ResponseEnvelope<T> {
  return { _meta: { version: MCP_VERSION, timestamp: new Date().toISOString() }, data };
}

const PLATFORM_ENUM = z.enum([
  'youtube',
  'tiktok',
  'instagram',
  'twitter',
  'linkedin',
  'facebook',
  'threads',
  'bluesky',
]);

// Cost estimate: ~15 credits per plan + 5 per source URL extraction
const BASE_PLAN_CREDITS = 15;
const SOURCE_EXTRACTION_CREDITS = 5;

export function registerPipelineTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // check_pipeline_readiness
  // ---------------------------------------------------------------------------
  server.tool(
    'check_pipeline_readiness',
    'Pre-flight check before run_content_pipeline. Verifies: sufficient credits for estimated_posts, active OAuth on target platforms, brand profile exists, no stale insights. Returns pass/fail with specific issues to fix before running the pipeline.',
    {
      project_id: z.string().uuid().optional().describe('Project ID (auto-detected if omitted)'),
      platforms: z.array(PLATFORM_ENUM).min(1).describe('Target platforms to check'),
      estimated_posts: z.number().min(1).max(50).default(5).describe('Estimated posts to generate'),
      response_format: z.enum(['text', 'json']).optional().describe('Response format'),
    },
    async ({ project_id, platforms, estimated_posts, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();

      try {
        const resolvedProjectId = project_id ?? (await getDefaultProjectId()) ?? undefined;
        const estimatedCost = BASE_PLAN_CREDITS + estimated_posts * 2;

        const { data: readiness, error: readinessError } = await callEdgeFunction<{
          success: boolean;
          credits: number;
          estimated_cost: number;
          connected_platforms: string[];
          missing_platforms: string[];
          has_brand: boolean;
          pending_approvals: number;
          latest_insight: { id: string; generated_at: string } | null;
          insight_age: number | null;
          insights_fresh: boolean;
        }>(
          'mcp-data',
          {
            action: 'pipeline-readiness',
            platforms,
            estimated_posts,
            ...(resolvedProjectId
              ? { projectId: resolvedProjectId, project_id: resolvedProjectId }
              : {}),
          },
          { timeoutMs: 15_000 }
        );

        if (readinessError || !readiness) {
          throw new Error(readinessError ?? 'No response from mcp-data');
        }

        const credits = readiness.credits;
        const connectedPlatforms = readiness.connected_platforms;
        const missingPlatforms = readiness.missing_platforms;
        const hasBrand = readiness.has_brand;
        const pendingApprovals = readiness.pending_approvals;
        const insightAge = readiness.insight_age;
        const insightsFresh = readiness.insights_fresh;

        const blockers: string[] = [];
        const warnings: string[] = [];

        if (credits < estimatedCost) {
          blockers.push(`Insufficient credits: ${credits} available, ~${estimatedCost} needed`);
        }
        if (missingPlatforms.length > 0) {
          blockers.push(`Missing connected accounts: ${missingPlatforms.join(', ')}`);
        }
        if (!hasBrand) {
          warnings.push('No brand profile found. Content will use generic voice.');
        }
        if (pendingApprovals > 0) {
          warnings.push(`${pendingApprovals} pending approval(s) from previous runs.`);
        }
        if (!insightsFresh) {
          warnings.push(
            insightAge === null
              ? 'No performance insights available. Pipeline will skip optimization.'
              : `Insights are ${insightAge} days old. Consider refreshing analytics.`
          );
        }

        const result: PipelineReadinessCheck = {
          ready: blockers.length === 0,
          checks: {
            credits: {
              available: credits,
              estimated_cost: estimatedCost,
              sufficient: credits >= estimatedCost,
            },
            connected_accounts: { platforms: connectedPlatforms, missing: missingPlatforms },
            brand_profile: { exists: hasBrand },
            pending_approvals: { count: pendingApprovals },
            insights_available: {
              count: readiness.latest_insight ? 1 : 0,
              fresh: insightsFresh,
              last_generated_at: readiness.latest_insight?.generated_at ?? null,
            },
          },
          blockers,
          warnings,
        };

        const durationMs = Date.now() - startedAt;
        logMcpToolInvocation({
          toolName: 'check_pipeline_readiness',
          status: 'success',
          durationMs,
          details: { ready: result.ready, blockers: blockers.length, warnings: warnings.length },
        });

        if (format === 'json') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(result), null, 2) }],
          };
        }

        // Text format
        const lines: string[] = [];
        lines.push(`Pipeline Readiness: ${result.ready ? 'READY' : 'NOT READY'}`);
        lines.push('='.repeat(40));
        lines.push(
          `Credits: ${credits} available, ~${estimatedCost} needed — ${credits >= estimatedCost ? 'OK' : 'BLOCKED'}`
        );
        lines.push(
          `Accounts: ${connectedPlatforms.length} connected${missingPlatforms.length > 0 ? ` (missing: ${missingPlatforms.join(', ')})` : ' — OK'}`
        );
        lines.push(`Brand: ${hasBrand ? 'OK' : 'Missing (will use generic voice)'}`);
        lines.push(`Pending Approvals: ${pendingApprovals}`);
        lines.push(
          `Insights: ${insightsFresh ? 'Fresh' : insightAge === null ? 'None available' : `${insightAge} days old`}`
        );
        if (blockers.length > 0) {
          lines.push('');
          lines.push('BLOCKERS:');
          for (const b of blockers) lines.push(`  ✗ ${b}`);
        }
        if (warnings.length > 0) {
          lines.push('');
          lines.push('WARNINGS:');
          for (const w of warnings) lines.push(`  ! ${w}`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        logMcpToolInvocation({
          toolName: 'check_pipeline_readiness',
          status: 'error',
          durationMs,
          details: { error: message },
        });
        return {
          content: [{ type: 'text' as const, text: `Readiness check failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // run_content_pipeline
  // ---------------------------------------------------------------------------
  server.tool(
    'run_content_pipeline',
    'Run the full content pipeline: research trends → generate plan → quality check → auto-approve → schedule posts. Chains all stages in one call for maximum efficiency. Set dry_run=true to preview the plan without publishing. Check check_pipeline_readiness first to verify credits, OAuth, and brand profile are ready.',
    {
      project_id: z.string().uuid().optional().describe('Project ID (auto-detected if omitted)'),
      topic: z.string().optional().describe('Content topic (required if no source_url)'),
      source_url: z.string().optional().describe('URL to extract content from'),
      platforms: z.array(PLATFORM_ENUM).min(1).describe('Target platforms'),
      days: z.number().min(1).max(7).default(5).describe('Days to plan'),
      posts_per_day: z.number().min(1).max(3).default(1).describe('Posts per platform per day'),
      approval_mode: z
        .enum(['auto', 'review_all', 'review_low_confidence'])
        .default('review_low_confidence')
        .describe(
          'auto: approve all passing quality. review_all: flag everything. review_low_confidence: auto-approve high scorers.'
        ),
      auto_approve_threshold: z
        .number()
        .min(0)
        .max(35)
        .default(28)
        .describe(
          'Quality score threshold for auto-approval (used in auto/review_low_confidence modes)'
        ),
      max_credits: z.number().optional().describe('Credit budget cap'),
      dry_run: z.boolean().default(false).describe('If true, skip scheduling and return plan only'),
      skip_stages: z
        .array(z.enum(['research', 'quality', 'schedule']))
        .optional()
        .describe('Stages to skip'),
      response_format: z.enum(['text', 'json']).default('json'),
    },
    async ({
      project_id,
      topic,
      source_url,
      platforms,
      days,
      posts_per_day,
      approval_mode,
      auto_approve_threshold,
      max_credits,
      dry_run,
      skip_stages,
      response_format,
    }) => {
      const startedAt = Date.now();
      const pipelineId = randomUUID();
      const stagesCompleted: string[] = [];
      const stagesSkipped: string[] = [];
      const errors: Array<{ stage: string; message: string }> = [];
      let creditsUsed = 0;

      if (!topic && !source_url) {
        return {
          content: [{ type: 'text' as const, text: 'Either topic or source_url is required.' }],
          isError: true,
        };
      }

      const skipSet = new Set(skip_stages ?? []);

      try {
        const resolvedProjectId = project_id ?? (await getDefaultProjectId()) ?? undefined;

        // Stage 1: Budget check
        const estimatedCost = BASE_PLAN_CREDITS + (source_url ? SOURCE_EXTRACTION_CREDITS : 0);
        const { data: budgetData } = await callEdgeFunction<{
          success: boolean;
          credits: number;
        }>(
          'mcp-data',
          {
            action: 'run-pipeline',
            plan_status: 'budget-check',
            ...(resolvedProjectId
              ? { projectId: resolvedProjectId, project_id: resolvedProjectId }
              : {}),
          },
          { timeoutMs: 10_000 }
        );

        const availableCredits = budgetData?.credits ?? 0;
        const creditLimit = max_credits ?? availableCredits;

        if (availableCredits < estimatedCost) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Insufficient credits: ${availableCredits} available, ~${estimatedCost} needed.`,
              },
            ],
            isError: true,
          };
        }
        stagesCompleted.push('budget_check');

        // Create pipeline_runs record
        await callEdgeFunction(
          'mcp-data',
          {
            action: 'run-pipeline',
            plan_status: 'create',
            pipeline_id: pipelineId,
            config: {
              topic,
              source_url,
              platforms,
              days,
              posts_per_day,
              approval_mode,
              auto_approve_threshold,
              dry_run,
              skip_stages: skip_stages ?? [],
            },
            current_stage: 'planning',
            ...(resolvedProjectId
              ? { projectId: resolvedProjectId, project_id: resolvedProjectId }
              : {}),
          },
          { timeoutMs: 10_000 }
        );

        // Stage 2: Planning (calls AI to generate plan)
        const resolvedTopic = topic ?? source_url ?? 'Content plan';
        const { data: planData, error: planError } = await callEdgeFunction<{
          text?: string;
          content?: string;
        }>(
          'social-neuron-ai',
          {
            type: 'generation',
            prompt: buildPlanPrompt(resolvedTopic, platforms, days, posts_per_day, source_url),
            model: 'gemini-2.5-flash',
            responseFormat: 'json',
            ...(resolvedProjectId
              ? { projectId: resolvedProjectId, project_id: resolvedProjectId }
              : {}),
          },
          { timeoutMs: 60_000 }
        );

        if (planError || !planData) {
          errors.push({ stage: 'planning', message: planError ?? 'No AI response' });
          await callEdgeFunction(
            'mcp-data',
            {
              action: 'run-pipeline',
              plan_status: 'update',
              pipeline_id: pipelineId,
              status: 'failed',
              stages_completed: stagesCompleted,
              errors,
              current_stage: null,
              completed_at: new Date().toISOString(),
            },
            { timeoutMs: 10_000 }
          );
          return {
            content: [
              { type: 'text' as const, text: `Planning failed: ${planError ?? 'No AI response'}` },
            ],
            isError: true,
          };
        }

        creditsUsed += BASE_PLAN_CREDITS;

        // Deduct credits via mcp-data
        if (!dry_run) {
          try {
            await callEdgeFunction(
              'mcp-data',
              {
                action: 'run-pipeline',
                plan_status: 'deduct-credits',
                credits_used: BASE_PLAN_CREDITS,
                reason: `Pipeline ${pipelineId.slice(0, 8)}: content plan generation`,
              },
              { timeoutMs: 10_000 }
            );
          } catch (deductErr) {
            errors.push({
              stage: 'planning',
              message: `Credit deduction failed: ${deductErr instanceof Error ? deductErr.message : String(deductErr)}`,
            });
          }
        }

        stagesCompleted.push('planning');

        // Parse posts from AI response
        const rawText = String(planData.text ?? planData.content ?? '');
        const postsArray = extractJsonArray(rawText);
        const posts: ContentPlanPost[] = (postsArray ?? []).map((p: any) => ({
          id: String(p.id ?? randomUUID().slice(0, 8)),
          day: Number(p.day ?? 1),
          date: String(p.date ?? ''),
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

        // Stage 3: Quality gate
        let postsApproved = 0;
        let postsFlagged = 0;

        if (!skipSet.has('quality')) {
          for (const post of posts) {
            const quality = evaluateQuality({
              caption: post.caption,
              title: post.title,
              platforms: [post.platform],
              threshold: auto_approve_threshold,
            });
            post.quality = {
              score: quality.total,
              max_score: quality.maxTotal,
              passed: quality.passed,
              blockers: quality.blockers,
            };

            if (approval_mode === 'auto' && quality.passed) {
              post.status = 'approved';
              postsApproved++;
            } else if (approval_mode === 'review_low_confidence') {
              if (quality.total >= auto_approve_threshold && quality.blockers.length === 0) {
                post.status = 'approved';
                postsApproved++;
              } else {
                post.status = 'needs_edit';
                postsFlagged++;
              }
            } else {
              // review_all
              post.status = 'pending';
              postsFlagged++;
            }
          }
          stagesCompleted.push('quality_check');
        } else {
          stagesSkipped.push('quality_check');
          // Auto-approve all if quality is skipped
          for (const post of posts) {
            post.status = 'approved';
            postsApproved++;
          }
        }

        // Stage 4: Persist plan
        const planId = randomUUID();
        if (resolvedProjectId) {
          const startDate = new Date();
          startDate.setDate(startDate.getDate() + 1);
          const endDate = new Date(startDate);
          endDate.setDate(endDate.getDate() + days - 1);

          await callEdgeFunction(
            'mcp-data',
            {
              action: 'run-pipeline',
              plan_status: 'persist-plan',
              pipeline_id: pipelineId,
              plan_id: planId,
              topic: resolvedTopic,
              status: postsFlagged > 0 ? 'in_review' : 'approved',
              plan_payload: {
                plan_id: planId,
                topic: resolvedTopic,
                platforms,
                posts,
                start_date: startDate.toISOString().split('T')[0],
                end_date: endDate.toISOString().split('T')[0],
                estimated_credits: estimatedCost,
                generated_at: new Date().toISOString(),
              },
              ...(resolvedProjectId
                ? { projectId: resolvedProjectId, project_id: resolvedProjectId }
                : {}),
            },
            { timeoutMs: 10_000 }
          );
        }
        stagesCompleted.push('persist_plan');

        // Stage 4b: Create approval records for flagged posts
        if (postsFlagged > 0 && resolvedProjectId) {
          const userId = await getDefaultUserId();
          const resolvedApprovalRows = posts
            .filter(p => p.status !== 'approved')
            .map(post => ({
              plan_id: planId,
              post_id: post.id,
              project_id: resolvedProjectId,
              user_id: userId,
              status: 'pending',
              original_post: post,
              auto_approved: false,
            }));

          if (resolvedApprovalRows.length > 0) {
            await callEdgeFunction(
              'mcp-data',
              {
                action: 'run-pipeline',
                plan_status: 'upsert-approvals',
                posts: resolvedApprovalRows,
              },
              { timeoutMs: 10_000 }
            );
          }
        }

        // Auto-approved records
        if (postsApproved > 0 && resolvedProjectId) {
          const userId = await getDefaultUserId();
          const autoApprovedRows = posts
            .filter(p => p.status === 'approved')
            .map(post => ({
              plan_id: planId,
              post_id: post.id,
              project_id: resolvedProjectId,
              user_id: userId,
              status: 'approved',
              original_post: post,
              auto_approved: true,
            }));

          if (autoApprovedRows.length > 0) {
            await callEdgeFunction(
              'mcp-data',
              {
                action: 'run-pipeline',
                plan_status: 'upsert-approvals',
                posts: autoApprovedRows,
              },
              { timeoutMs: 10_000 }
            );
          }
        }

        // Stage 5: Schedule (if not dry_run and not skipped)
        let postsScheduled = 0;
        if (!dry_run && !skipSet.has('schedule') && postsApproved > 0) {
          const approvedPosts = posts.filter(p => p.status === 'approved');
          for (const post of approvedPosts) {
            if (creditsUsed >= creditLimit) {
              errors.push({ stage: 'schedule', message: 'Credit limit reached' });
              break;
            }
            try {
              const { error: schedError } = await callEdgeFunction(
                'schedule-post',
                {
                  platform: post.platform,
                  caption: post.caption,
                  title: post.title,
                  hashtags: post.hashtags,
                  media_url: post.media_url,
                  scheduled_at: post.schedule_at,
                  ...(resolvedProjectId
                    ? { projectId: resolvedProjectId, project_id: resolvedProjectId }
                    : {}),
                },
                { timeoutMs: 15_000 }
              );

              if (schedError) {
                errors.push({
                  stage: 'schedule',
                  message: `Failed to schedule ${post.id}: ${schedError}`,
                });
              } else {
                postsScheduled++;
              }
            } catch (schedErr) {
              errors.push({
                stage: 'schedule',
                message: `Failed to schedule ${post.id}: ${schedErr instanceof Error ? schedErr.message : String(schedErr)}`,
              });
            }
          }
          stagesCompleted.push('schedule');
        } else if (dry_run) {
          stagesSkipped.push('schedule');
        } else if (skipSet.has('schedule')) {
          stagesSkipped.push('schedule');
        }

        // Final status
        const finalStatus =
          errors.length > 0 && stagesCompleted.length <= 2
            ? ('failed' as const)
            : postsFlagged > 0
              ? ('awaiting_approval' as const)
              : ('completed' as const);

        await callEdgeFunction(
          'mcp-data',
          {
            action: 'run-pipeline',
            plan_status: 'update',
            pipeline_id: pipelineId,
            status: finalStatus,
            plan_id: planId,
            stages_completed: stagesCompleted,
            stages_skipped: stagesSkipped,
            current_stage: null,
            posts_generated: posts.length,
            posts_approved: postsApproved,
            posts_scheduled: postsScheduled,
            posts_flagged: postsFlagged,
            credits_used: creditsUsed,
            errors,
            completed_at: new Date().toISOString(),
          },
          { timeoutMs: 10_000 }
        );

        const durationMs = Date.now() - startedAt;
        logMcpToolInvocation({
          toolName: 'run_content_pipeline',
          status: 'success',
          durationMs,
          details: {
            pipeline_id: pipelineId,
            posts: posts.length,
            approved: postsApproved,
            scheduled: postsScheduled,
            flagged: postsFlagged,
          },
        });

        const resultPayload = {
          pipeline_id: pipelineId,
          stages_completed: stagesCompleted,
          stages_skipped: stagesSkipped,
          plan_id: planId,
          posts_generated: posts.length,
          posts_approved: postsApproved,
          posts_scheduled: postsScheduled,
          posts_flagged: postsFlagged,
          credits_used: creditsUsed,
          credits_remaining: availableCredits - creditsUsed,
          dry_run,
          next_action:
            postsFlagged > 0
              ? `Review ${postsFlagged} flagged post(s) with list_plan_approvals and respond_plan_approval.`
              : postsScheduled > 0
                ? 'All posts scheduled. Monitor with get_pipeline_status.'
                : 'Pipeline complete.',
          errors: errors.length > 0 ? errors : undefined,
        };

        if (response_format === 'json') {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(asEnvelope(resultPayload), null, 2) },
            ],
          };
        }

        // Text format
        const lines: string[] = [];
        lines.push(`Pipeline ${pipelineId.slice(0, 8)}... ${finalStatus.toUpperCase()}`);
        lines.push('='.repeat(40));
        lines.push(`Posts generated: ${posts.length}`);
        lines.push(`Posts approved: ${postsApproved}`);
        lines.push(`Posts scheduled: ${postsScheduled}`);
        lines.push(`Posts flagged for review: ${postsFlagged}`);
        lines.push(`Credits used: ${creditsUsed}`);
        lines.push(`Stages: ${stagesCompleted.join(' → ')}`);
        if (stagesSkipped.length > 0) {
          lines.push(`Skipped: ${stagesSkipped.join(', ')}`);
        }
        if (errors.length > 0) {
          lines.push('');
          lines.push('Errors:');
          for (const e of errors) lines.push(`  [${e.stage}] ${e.message}`);
        }
        lines.push('');
        lines.push(`Next: ${resultPayload.next_action}`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        logMcpToolInvocation({
          toolName: 'run_content_pipeline',
          status: 'error',
          durationMs,
          details: { error: message },
        });
        // Best-effort update of pipeline_runs to prevent orphaned 'running' records
        try {
          await callEdgeFunction(
            'mcp-data',
            {
              action: 'run-pipeline',
              plan_status: 'update',
              pipeline_id: pipelineId,
              status: 'failed',
              stages_completed: stagesCompleted,
              errors: [...errors, { stage: 'unknown', message }],
              current_stage: null,
              completed_at: new Date().toISOString(),
            },
            { timeoutMs: 10_000 }
          );
        } catch {
          // Ignore — best-effort cleanup
        }
        return {
          content: [{ type: 'text' as const, text: `Pipeline failed: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // get_pipeline_status
  // ---------------------------------------------------------------------------
  server.tool(
    'get_pipeline_status',
    'Check status of a pipeline run, including stages completed, pending approvals, and scheduled posts.',
    {
      pipeline_id: z.string().uuid().optional().describe('Pipeline run ID (omit for latest)'),
      response_format: z.enum(['text', 'json']).optional(),
    },
    async ({ pipeline_id, response_format }) => {
      const format = response_format ?? 'text';

      const { data: result, error: fetchError } = await callEdgeFunction<{
        success: boolean;
        pipeline: Record<string, unknown> | null;
      }>(
        'mcp-data',
        {
          action: 'get-pipeline-status',
          ...(pipeline_id ? { pipeline_id } : {}),
        },
        { timeoutMs: 10_000 }
      );

      if (fetchError) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${fetchError}` }],
          isError: true,
        };
      }

      const data = result?.pipeline;

      if (!data) {
        return {
          content: [{ type: 'text' as const, text: 'No pipeline runs found.' }],
        };
      }

      if (format === 'json') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(asEnvelope(data), null, 2) }],
        };
      }

      const lines: string[] = [];
      lines.push(
        `Pipeline ${String(data.id).slice(0, 8)}... — ${String(data.status).toUpperCase()}`
      );
      lines.push('='.repeat(40));
      lines.push(`Started: ${data.started_at}`);
      if (data.completed_at) lines.push(`Completed: ${data.completed_at}`);
      lines.push(
        `Stages: ${(Array.isArray(data.stages_completed) ? data.stages_completed : []).join(' → ') || 'none'}`
      );
      if (Array.isArray(data.stages_skipped) && data.stages_skipped.length > 0) {
        lines.push(`Skipped: ${data.stages_skipped.join(', ')}`);
      }
      lines.push(
        `Posts: ${data.posts_generated} generated, ${data.posts_approved} approved, ${data.posts_scheduled} scheduled, ${data.posts_flagged} flagged`
      );
      lines.push(`Credits used: ${data.credits_used}`);
      if (data.plan_id) lines.push(`Plan ID: ${data.plan_id}`);
      const errs = data.errors as Array<{ stage: string; message: string }> | null;
      if (errs && errs.length > 0) {
        lines.push('');
        lines.push('Errors:');
        for (const e of errs) lines.push(`  [${e.stage}] ${e.message}`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  // ---------------------------------------------------------------------------
  // auto_approve_plan
  // ---------------------------------------------------------------------------
  server.tool(
    'auto_approve_plan',
    'Batch auto-approve posts in a content plan that meet quality thresholds. ' +
      'Posts below the threshold are flagged for manual review.',
    {
      plan_id: z.string().uuid().describe('Content plan ID'),
      quality_threshold: z
        .number()
        .min(0)
        .max(35)
        .default(26)
        .describe('Minimum quality score to auto-approve'),
      response_format: z.enum(['text', 'json']).default('json'),
    },
    async ({ plan_id, quality_threshold, response_format }) => {
      const startedAt = Date.now();

      try {
        // Load the plan via mcp-data
        const { data: loadResult, error: loadError } = await callEdgeFunction<{
          success: boolean;
          plan: {
            id: string;
            project_id: string;
            status: string;
            plan_payload: { posts: ContentPlanPost[] };
          } | null;
        }>('mcp-data', { action: 'auto-approve-plan', plan_id }, { timeoutMs: 10_000 });

        if (loadError) {
          return {
            content: [{ type: 'text' as const, text: `Failed to load plan: ${loadError}` }],
            isError: true,
          };
        }

        const stored = loadResult?.plan;
        if (!stored?.plan_payload) {
          return {
            content: [
              { type: 'text' as const, text: `No content plan found for plan_id=${plan_id}` },
            ],
            isError: true,
          };
        }

        const plan = stored.plan_payload;
        const posts = Array.isArray(plan.posts) ? plan.posts : [];

        let autoApproved = 0;
        let flagged = 0;
        let rejected = 0;
        const details: Array<{ post_id: string; action: string; score: number }> = [];

        for (const post of posts) {
          const quality = evaluateQuality({
            caption: post.caption,
            title: post.title,
            platforms: [post.platform],
            threshold: quality_threshold,
          });

          if (quality.total >= quality_threshold && quality.blockers.length === 0) {
            post.status = 'approved';
            post.quality = {
              score: quality.total,
              max_score: quality.maxTotal,
              passed: true,
              blockers: [],
            };
            autoApproved++;
            details.push({ post_id: post.id, action: 'approved', score: quality.total });
          } else if (quality.total >= quality_threshold - 5) {
            post.status = 'needs_edit';
            post.quality = {
              score: quality.total,
              max_score: quality.maxTotal,
              passed: false,
              blockers: quality.blockers,
            };
            flagged++;
            details.push({ post_id: post.id, action: 'flagged', score: quality.total });
          } else {
            post.status = 'rejected';
            post.quality = {
              score: quality.total,
              max_score: quality.maxTotal,
              passed: false,
              blockers: quality.blockers,
            };
            rejected++;
            details.push({ post_id: post.id, action: 'rejected', score: quality.total });
          }
        }

        // Save results via mcp-data
        const newStatus = flagged === 0 && rejected === 0 ? 'approved' : 'in_review';

        const userId = await getDefaultUserId();
        const resolvedRows = posts.map(post => ({
          plan_id,
          post_id: post.id,
          project_id: stored.project_id,
          user_id: userId,
          status:
            post.status === 'approved'
              ? 'approved'
              : post.status === 'rejected'
                ? 'rejected'
                : 'pending',
          original_post: post,
          auto_approved: post.status === 'approved',
        }));

        await callEdgeFunction(
          'mcp-data',
          {
            action: 'auto-approve-plan',
            plan_id,
            plan_status: newStatus,
            plan_payload: { ...plan, posts },
            posts: resolvedRows,
          },
          { timeoutMs: 10_000 }
        );

        const durationMs = Date.now() - startedAt;
        logMcpToolInvocation({
          toolName: 'auto_approve_plan',
          status: 'success',
          durationMs,
          details: { plan_id, auto_approved: autoApproved, flagged, rejected },
        });

        const resultPayload = {
          plan_id,
          auto_approved: autoApproved,
          flagged_for_review: flagged,
          rejected,
          details,
          plan_status: newStatus,
        };

        if (response_format === 'json') {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(asEnvelope(resultPayload), null, 2) },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(`Auto-Approve Results for Plan ${plan_id.slice(0, 8)}...`);
        lines.push('='.repeat(40));
        lines.push(`Auto-approved: ${autoApproved}`);
        lines.push(`Flagged for review: ${flagged}`);
        lines.push(`Rejected: ${rejected}`);
        lines.push(`Plan status: ${newStatus}`);
        if (details.length > 0) {
          lines.push('');
          for (const d of details) {
            lines.push(`  ${d.post_id}: ${d.action} (score: ${d.score}/35)`);
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        logMcpToolInvocation({
          toolName: 'auto_approve_plan',
          status: 'error',
          durationMs,
          details: { error: message },
        });
        return {
          content: [{ type: 'text' as const, text: `Auto-approve failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sanitizeTopic(raw: string): string {
  // Strip control characters and limit length to prevent prompt injection
  return raw.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500);
}

function buildPlanPrompt(
  topic: string,
  platforms: string[],
  days: number,
  postsPerDay: number,
  sourceUrl?: string
): string {
  const safeTopic = sanitizeTopic(topic);
  const parts = [
    `Generate a ${days}-day content plan for "${safeTopic}" across platforms: ${platforms.join(', ')}.`,
    `${postsPerDay} post(s) per platform per day.`,
    sourceUrl ? `Source material URL: ${sourceUrl}` : '',
    '',
    'For each post, return a JSON object with:',
    '  id, day, date, platform, content_type, caption, title, hashtags, hook, angle, visual_direction, media_type',
    '',
    'Return ONLY a JSON array. No surrounding text.',
  ];
  return parts.filter(Boolean).join('\n');
}
