import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerPipelineTools } from './pipeline.js';
import { getDefaultUserId, getDefaultProjectId } from '../lib/supabase.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockGetUserId = vi.mocked(getDefaultUserId);
const mockGetProjectId = vi.mocked(getDefaultProjectId);
const mockCallEdgeFunction = vi.mocked(callEdgeFunction);

describe('pipeline tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerPipelineTools(server as any);
    mockGetUserId.mockResolvedValue('test-user-id');
    mockGetProjectId.mockResolvedValue('test-project-id');
  });

  // =========================================================================
  // check_pipeline_readiness
  // =========================================================================
  describe('check_pipeline_readiness', () => {
    it('returns ready when all checks pass', async () => {
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: {
          success: true,
          credits: 500,
          estimated_cost: 25,
          connected_platforms: ['tiktok'],
          missing_platforms: [],
          has_brand: true,
          pending_approvals: 0,
          latest_insight: { id: 'i1', generated_at: new Date().toISOString() },
          insight_age: 1,
          insights_fresh: true,
        },
        error: null,
      } as any);

      const handler = server.getHandler('check_pipeline_readiness')!;
      const result = await handler({ platforms: ['tiktok'], estimated_posts: 5 });
      const text = result.content[0].text;
      expect(text).toContain('READY');
      expect(text).not.toContain('NOT READY');
    });

    it('returns not ready with insufficient credits', async () => {
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: {
          success: true,
          credits: 5,
          estimated_cost: 25,
          connected_platforms: ['tiktok'],
          missing_platforms: [],
          has_brand: true,
          pending_approvals: 0,
          latest_insight: null,
          insight_age: null,
          insights_fresh: false,
        },
        error: null,
      } as any);

      const handler = server.getHandler('check_pipeline_readiness')!;
      const result = await handler({ platforms: ['tiktok'], estimated_posts: 5 });
      const text = result.content[0].text;
      expect(text).toContain('NOT READY');
      expect(text).toContain('Insufficient credits');
    });

    it('returns not ready with missing platform accounts', async () => {
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: {
          success: true,
          credits: 500,
          estimated_cost: 25,
          connected_platforms: [],
          missing_platforms: ['tiktok', 'youtube'],
          has_brand: false,
          pending_approvals: 0,
          latest_insight: null,
          insight_age: null,
          insights_fresh: false,
        },
        error: null,
      } as any);

      const handler = server.getHandler('check_pipeline_readiness')!;
      const result = await handler({
        platforms: ['tiktok', 'youtube'],
        estimated_posts: 5,
      });
      const text = result.content[0].text;
      expect(text).toContain('NOT READY');
      expect(text).toContain('Missing connected accounts');
    });

    it('returns JSON format when requested', async () => {
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: {
          success: true,
          credits: 500,
          estimated_cost: 25,
          connected_platforms: ['tiktok'],
          missing_platforms: [],
          has_brand: true,
          pending_approvals: 0,
          latest_insight: null,
          insight_age: null,
          insights_fresh: false,
        },
        error: null,
      } as any);

      const handler = server.getHandler('check_pipeline_readiness')!;
      const result = await handler({
        platforms: ['tiktok'],
        estimated_posts: 5,
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBeDefined();
      expect(parsed.data.checks).toBeDefined();
    });
  });

  // =========================================================================
  // run_content_pipeline
  // =========================================================================
  describe('run_content_pipeline', () => {
    it('requires topic or source_url', async () => {
      const handler = server.getHandler('run_content_pipeline')!;
      const result = await handler({ platforms: ['tiktok'] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Either topic or source_url is required');
    });

    it('aborts with insufficient credits', async () => {
      // budget-check call
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true, credits: 1 },
        error: null,
      } as any);

      const handler = server.getHandler('run_content_pipeline')!;
      const result = await handler({
        topic: 'AI tips',
        platforms: ['tiktok'],
        days: 5,
        posts_per_day: 1,
        approval_mode: 'auto',
        auto_approve_threshold: 28,
        dry_run: false,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Insufficient credits');
    });

    it('runs full pipeline in dry_run mode', async () => {
      // budget-check
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true, credits: 500 },
        error: null,
      } as any);
      // create pipeline run
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);
      // social-neuron-ai call
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: {
          text: JSON.stringify([
            {
              id: 'day1-tiktok-1',
              day: 1,
              date: '2026-03-19',
              platform: 'tiktok',
              content_type: 'caption',
              caption:
                'How to use AI for content creation — a complete breakdown of the workflow you need to try',
              hook: 'Stop creating content manually',
              angle: 'Practical AI workflow',
              title: 'AI Content Tips',
            },
          ]),
        },
        error: null,
      } as any);
      // persist-plan
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);
      // upsert-approvals (auto-approved)
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);
      // update pipeline run (final)
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);

      const handler = server.getHandler('run_content_pipeline')!;
      const result = await handler({
        topic: 'AI tips',
        platforms: ['tiktok'],
        days: 5,
        posts_per_day: 1,
        approval_mode: 'review_low_confidence',
        auto_approve_threshold: 28,
        dry_run: true,
        response_format: 'json',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.posts_generated).toBe(1);
      expect(parsed.data.dry_run).toBe(true);
      expect(parsed.data.stages_completed).toContain('planning');
      expect(parsed.data.stages_completed).toContain('quality_check');
      expect(parsed.data.stages_skipped).toContain('schedule');
    });

    it('fails gracefully when AI returns bad data', async () => {
      // budget-check
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true, credits: 500 },
        error: null,
      } as any);
      // create pipeline run
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);
      // social-neuron-ai returns error
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: null,
        error: 'AI unavailable',
      } as any);
      // update pipeline run (failure)
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);

      const handler = server.getHandler('run_content_pipeline')!;
      const result = await handler({
        topic: 'AI tips',
        platforms: ['tiktok'],
        days: 5,
        posts_per_day: 1,
        approval_mode: 'auto',
        auto_approve_threshold: 28,
        dry_run: false,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Planning failed');
    });

    it('skips quality when skip_stages includes quality', async () => {
      // budget-check
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true, credits: 500 },
        error: null,
      } as any);
      // create pipeline run
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);
      // social-neuron-ai
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: {
          text: JSON.stringify([
            {
              id: 'day1-tiktok-1',
              day: 1,
              platform: 'tiktok',
              content_type: 'caption',
              caption: 'Test post',
              hook: 'Test hook',
              angle: 'Test angle',
            },
          ]),
        },
        error: null,
      } as any);
      // persist-plan
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);
      // upsert-approvals (auto-approved)
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);
      // update pipeline run (final)
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);

      const handler = server.getHandler('run_content_pipeline')!;
      const result = await handler({
        topic: 'AI tips',
        platforms: ['tiktok'],
        days: 5,
        posts_per_day: 1,
        approval_mode: 'auto',
        auto_approve_threshold: 28,
        dry_run: true,
        skip_stages: ['quality'],
        response_format: 'json',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.stages_skipped).toContain('quality_check');
      expect(parsed.data.posts_approved).toBe(1); // auto-approved when quality skipped
    });
  });

  // =========================================================================
  // get_pipeline_status
  // =========================================================================
  describe('get_pipeline_status', () => {
    it('returns latest pipeline run', async () => {
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: {
          success: true,
          pipeline: {
            id: 'pipe-111',
            status: 'completed',
            started_at: '2026-03-18T10:00:00Z',
            completed_at: '2026-03-18T10:05:00Z',
            stages_completed: ['budget_check', 'planning', 'quality_check'],
            stages_skipped: [],
            posts_generated: 5,
            posts_approved: 4,
            posts_scheduled: 4,
            posts_flagged: 1,
            credits_used: 15,
            plan_id: 'plan-222',
            errors: [],
          },
        },
        error: null,
      } as any);

      const handler = server.getHandler('get_pipeline_status')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain('COMPLETED');
      expect(text).toContain('5 generated');
      expect(text).toContain('4 approved');
    });

    it('returns no runs found when empty', async () => {
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true, pipeline: null },
        error: null,
      } as any);

      const handler = server.getHandler('get_pipeline_status')!;
      const result = await handler({});
      expect(result.content[0].text).toContain('No pipeline runs found');
    });

    it('returns JSON format', async () => {
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: {
          success: true,
          pipeline: {
            id: 'pipe-111',
            status: 'completed',
            started_at: '2026-03-18T10:00:00Z',
            completed_at: null,
            stages_completed: [],
            stages_skipped: [],
            posts_generated: 0,
            posts_approved: 0,
            posts_scheduled: 0,
            posts_flagged: 0,
            credits_used: 0,
            plan_id: null,
            errors: [],
          },
        },
        error: null,
      } as any);

      const handler = server.getHandler('get_pipeline_status')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBeDefined();
      expect(parsed.data.id).toBe('pipe-111');
    });
  });

  // =========================================================================
  // auto_approve_plan
  // =========================================================================
  describe('auto_approve_plan', () => {
    const TEST_PLAN_ID = '550e8400-e29b-41d4-a716-446655440000';

    it('auto-approves posts meeting quality threshold', async () => {
      // Load plan
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: {
          success: true,
          plan: {
            id: TEST_PLAN_ID,
            project_id: 'proj-1',
            status: 'draft',
            plan_payload: {
              posts: [
                {
                  id: 'p1',
                  platform: 'tiktok',
                  caption:
                    'How to build a content strategy that scales — 5 steps you need to follow today!',
                  hook: 'Stop guessing what to post',
                  angle: 'Strategic approach',
                  content_type: 'caption',
                  day: 1,
                  date: '2026-03-19',
                },
              ],
            },
          },
        },
        error: null,
      } as any);
      // Save results
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);

      const handler = server.getHandler('auto_approve_plan')!;
      const result = await handler({ plan_id: TEST_PLAN_ID, quality_threshold: 15 });
      const text = result.content[0].text;
      expect(text).toContain('Auto-approved:');
    });

    it('returns error for missing plan', async () => {
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true, plan: null },
        error: null,
      } as any);

      const handler = server.getHandler('auto_approve_plan')!;
      const result = await handler({ plan_id: TEST_PLAN_ID });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No content plan found');
    });

    it('returns JSON format', async () => {
      // Load plan
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: {
          success: true,
          plan: {
            id: TEST_PLAN_ID,
            project_id: 'proj-1',
            status: 'draft',
            plan_payload: {
              posts: [
                {
                  id: 'p1',
                  platform: 'tiktok',
                  caption:
                    'A practical breakdown of the workflow that helped us grow to 50K followers',
                  hook: 'From 0 to 50K in 6 months',
                  angle: 'Case study',
                  content_type: 'caption',
                  day: 1,
                  date: '2026-03-19',
                },
              ],
            },
          },
        },
        error: null,
      } as any);
      // Save results
      mockCallEdgeFunction.mockResolvedValueOnce({
        data: { success: true },
        error: null,
      } as any);

      const handler = server.getHandler('auto_approve_plan')!;
      const result = await handler({
        plan_id: TEST_PLAN_ID,
        quality_threshold: 15,
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBeDefined();
      expect(parsed.data.plan_id).toBe(TEST_PLAN_ID);
      expect(typeof parsed.data.auto_approved).toBe('number');
    });
  });
});
