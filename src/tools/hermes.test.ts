import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerHermesTools } from './hermes.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('hermes tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerHermesTools(server as never);
  });

  // ──────────────────────────────────────────────────────────────────────
  // save_draft_to_library
  // ──────────────────────────────────────────────────────────────────────
  describe('save_draft_to_library', () => {
    it('routes to mcp-data with save-draft-to-library action', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, content_id: 'c-123' },
        error: null,
      });

      const handler = server.getHandler('save_draft_to_library')!;
      const result = await handler({
        platform: 'twitter',
        copy: 'hello world',
        project_id: 'p-1',
        hermes_run_id: 'cron_abc_20260522',
      });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'save-draft-to-library',
          platform: 'twitter',
          copy: 'hello world',
          project_id: 'p-1',
          hermes_run_id: 'cron_abc_20260522',
        })
      );
      expect(result.content[0].text).toContain('c-123');
      expect(result.isError).toBeUndefined();
    });

    it('returns isError on EF failure', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: null, error: 'boom' });
      const handler = server.getHandler('save_draft_to_library')!;
      const result = await handler({ platform: 'instagram', copy: 'x' });
      expect(result.isError).toBe(true);
      // Structured error (toolError) — the real upstream message must still
      // reach the model (this was the "[object Object]" swallow bug), now
      // carried as `message` inside a machine-readable envelope instead of a
      // bare `Error: ${error}` string.
      expect(result.content[0].text).toContain('boom');
      expect(result.structuredContent?.error?.error_type).toBe('upstream_error');
      expect(result.structuredContent?.error?.message).toBe('boom');
    });

    it('classifies auth/permission failures as permission_denied, not upstream_error', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error:
          "Authentication failed (HTTP 401). Run 'npx @socialneuron/mcp-server login' to re-authenticate.",
      });
      const handler = server.getHandler('save_draft_to_library')!;
      const result = await handler({ platform: 'instagram', copy: 'x' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error?.error_type).toBe('permission_denied');
    });

    it('classifies rate-limit failures as rate_limited', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error:
          'Rate limit exceeded (HTTP 429). Wait 60s before retrying. Reduce request frequency or upgrade your plan.',
      });
      const handler = server.getHandler('save_draft_to_library')!;
      const result = await handler({ platform: 'instagram', copy: 'x' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error?.error_type).toBe('rate_limited');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, content_id: 'c-456' },
        error: null,
      });
      const handler = server.getHandler('save_draft_to_library')!;
      const result = await handler({
        platform: 'instagram',
        copy: 'x',
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBeDefined();
      expect(parsed.data.content_id).toBe('c-456');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // record_voice_lesson
  // ──────────────────────────────────────────────────────────────────────
  describe('record_voice_lesson', () => {
    it('passes evidence + applies_to through', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, lesson_id: 'l-1', total_count: 1 },
        error: null,
      });

      const handler = server.getHandler('record_voice_lesson')!;
      const result = await handler({
        project_id: 'p-1',
        lesson: 'lowercase IG hooks beat title-case',
        evidence: { engagement_lift_pct: 47, sample_size: 8 },
        applies_to: ['instagram', 'twitter'],
      });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'record-voice-lesson',
          lesson: 'lowercase IG hooks beat title-case',
          evidence: { engagement_lift_pct: 47, sample_size: 8 },
          applies_to: ['instagram', 'twitter'],
        })
      );
      expect(result.content[0].text).toContain('l-1');
      expect(result.content[0].text).toContain('1 lessons');
    });

    it('surfaces total_count from EF', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, lesson_id: 'l-2', total_count: 23 },
        error: null,
      });
      const handler = server.getHandler('record_voice_lesson')!;
      const result = await handler({
        project_id: 'p-1',
        lesson: 'rule',
        evidence: { engagement_lift_pct: 30, sample_size: 5 },
        applies_to: ['linkedin'],
      });
      expect(result.content[0].text).toContain('23 lessons');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // record_observation
  // ──────────────────────────────────────────────────────────────────────
  describe('record_observation', () => {
    it('routes with summary + deltas', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, observation_id: 'o-1' },
        error: null,
      });

      const handler = server.getHandler('record_observation')!;
      const result = await handler({
        summary: 'closed_loop_learning topic up 23% this week',
        deltas: { topic_lift_pct: 23 },
        run_id: 'cron_xyz_20260524',
      });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'record-observation',
          summary: 'closed_loop_learning topic up 23% this week',
          deltas: { topic_lift_pct: 23 },
          run_id: 'cron_xyz_20260524',
        })
      );
      expect(result.content[0].text).toContain('o-1');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // record_intel_signal
  // ──────────────────────────────────────────────────────────────────────
  describe('record_intel_signal', () => {
    it('inserts new signal', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, signal_id: 's-1', deduped: false },
        error: null,
      });

      const handler = server.getHandler('record_intel_signal')!;
      const result = await handler({
        source: 'news-watch',
        url: 'https://example.com/article',
        topic: 'ai_infra',
        title: 'OpenAI ships Geometry',
        score: 7.5,
      });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'record-intel-signal',
          source: 'news-watch',
          url: 'https://example.com/article',
        })
      );
      expect(result.content[0].text).toContain('s-1');
      expect(result.content[0].text).not.toContain('deduped');
    });

    it('reports dedupe on conflict', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, signal_id: null, deduped: true },
        error: null,
      });
      const handler = server.getHandler('record_intel_signal')!;
      const result = await handler({
        source: 'news-watch',
        url: 'https://example.com/dup',
      });
      expect(result.content[0].text).toContain('deduped');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // record_campaign_spend
  // ──────────────────────────────────────────────────────────────────────
  describe('record_campaign_spend', () => {
    it('logs spend and surfaces running total', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, spend_id: 'sp-1', campaign_total_usd: 4.17 },
        error: null,
      });

      const handler = server.getHandler('record_campaign_spend')!;
      const result = await handler({
        campaign_id: 'dogfood-diaries',
        category: 'hermes_drafts',
        amount_usd: 0.015,
      });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'record-campaign-spend',
          campaign_id: 'dogfood-diaries',
          category: 'hermes_drafts',
          amount_usd: 0.015,
        })
      );
      expect(result.content[0].text).toContain('$0.0150');
      expect(result.content[0].text).toContain('$4.17');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // get_active_campaigns
  // ──────────────────────────────────────────────────────────────────────
  describe('get_active_campaigns', () => {
    it('lists campaigns with budget and spend', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          campaigns: [
            {
              id: 'dogfood-diaries',
              name: 'Dogfood Diaries',
              thesis: 'We use SN to grow SN',
              budget_usd: 25,
              started_at: '2026-05-22T00:00:00Z',
              ends_at: '2026-07-03T00:00:00Z',
              hero_format: 'carousel',
              current_spend_usd: 1.2,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('get_active_campaigns')!;
      const result = await handler({});
      expect(result.content[0].text).toContain('Dogfood Diaries');
      expect(result.content[0].text).toContain('$25');
      expect(result.content[0].text).toContain('$1.20');
      expect(result.content[0].text).toContain('carousel');
    });

    it('returns empty-state message when no campaigns', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, campaigns: [] },
        error: null,
      });
      const handler = server.getHandler('get_active_campaigns')!;
      const result = await handler({});
      expect(result.content[0].text).toBe('No active campaigns.');
    });

    it('JSON envelope returns campaigns array', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          campaigns: [
            {
              id: 'c1',
              name: 'Test',
              thesis: null,
              budget_usd: 10,
              started_at: null,
              ends_at: null,
              hero_format: null,
              current_spend_usd: 0,
            },
          ],
        },
        error: null,
      });
      const handler = server.getHandler('get_active_campaigns')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.campaigns).toHaveLength(1);
      expect(parsed.data.campaigns[0].id).toBe('c1');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // record_heartbeat
  // ──────────────────────────────────────────────────────────────────────
  describe('record_heartbeat', () => {
    it('routes to mcp-data with record-heartbeat action, passing the caller-supplied run_id through', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, event_id: 'evt-1' },
        error: null,
      });

      const handler = server.getHandler('record_heartbeat')!;
      const result = await handler({
        agent: 'cfo-report',
        phase: 'start',
        run_id: 'run-abc',
      });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'record-heartbeat',
          agent: 'cfo-report',
          phase: 'start',
          run_id: 'run-abc',
        })
      );
      expect(result.content[0].text).toContain('start');
      expect(result.content[0].text).toContain('run-abc');
      expect(result.isError).toBeUndefined();
    });

    it('auto-generates a UUID run_id when omitted, and returns it in the response', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, event_id: 'evt-2' },
        error: null,
      });

      const handler = server.getHandler('record_heartbeat')!;
      const result = await handler({ agent: 'hermes-fleet-digest', phase: 'start' });

      const call = mockCallEdge.mock.calls[0];
      const body = call[1] as Record<string, unknown>;
      expect(typeof body.run_id).toBe('string');
      expect((body.run_id as string).length).toBeGreaterThan(0);
      expect(result.content[0].text).toContain(body.run_id as string);
    });

    it('passes phase=end fields (status, duration_ms, note, artifact_path) through', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, event_id: 'evt-3' },
        error: null,
      });

      const handler = server.getHandler('record_heartbeat')!;
      await handler({
        agent: 'cfo-report',
        phase: 'end',
        run_id: 'run-abc',
        status: 'ok',
        duration_ms: 4200,
        note: 'ran clean, no anomalies',
        artifact_path: 'docs/reports/2026-07-13-example-report.md',
      });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'record-heartbeat',
          phase: 'end',
          status: 'ok',
          duration_ms: 4200,
          note: 'ran clean, no anomalies',
          artifact_path: 'docs/reports/2026-07-13-example-report.md',
        })
      );
    });

    it('returns isError on EF failure', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: null, error: 'boom' });
      const handler = server.getHandler('record_heartbeat')!;
      const result = await handler({ agent: 'cfo-report', phase: 'start' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error: boom');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, event_id: 'evt-4' },
        error: null,
      });
      const handler = server.getHandler('record_heartbeat')!;
      const result = await handler({
        agent: 'cfo-report',
        phase: 'start',
        run_id: 'run-json',
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBeDefined();
      expect(parsed.data.run_id).toBe('run-json');
      expect(parsed.data.event_id).toBe('evt-4');
    });
  });
});
