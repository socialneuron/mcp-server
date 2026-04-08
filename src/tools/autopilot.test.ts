import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerAutopilotTools } from './autopilot.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('autopilot tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerAutopilotTools(server as any);
  });

  // =========================================================================
  // list_autopilot_configs
  // =========================================================================
  describe('list_autopilot_configs', () => {
    it('returns all configs for user in text format', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          configs: [
            {
              id: 'cfg-111',
              recipe_id: 'r-1',
              is_active: true,
              schedule_config: { days: ['mon', 'wed'], time: '09:00' },
              max_credits_per_run: 100,
              max_credits_per_week: 500,
              credits_used_this_week: 50,
              last_run_at: '2026-02-15T09:00:00Z',
              created_at: '2026-01-01T00:00:00Z',
              mode: 'recipe',
            },
            {
              id: 'cfg-222',
              recipe_id: 'r-2',
              is_active: false,
              schedule_config: null,
              max_credits_per_run: 0,
              max_credits_per_week: 0,
              credits_used_this_week: 0,
              last_run_at: null,
              created_at: '2026-02-01T00:00:00Z',
              mode: 'freestyle',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('list_autopilot_configs')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain('Autopilot Configurations (2)');
      expect(text).toContain('ID: cfg-111');
      expect(text).toContain('Status: ACTIVE');
      expect(text).toContain('Schedule: mon, wed @ 09:00');
      expect(text).toContain('ID: cfg-222');
      expect(text).toContain('Status: PAUSED');
    });

    it('passes active_only flag to edge function', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          configs: [
            {
              id: 'cfg-active',
              recipe_id: 'r-1',
              is_active: true,
              schedule_config: { days: ['fri'], time: '14:00' },
              max_credits_per_run: 50,
              max_credits_per_week: 200,
              credits_used_this_week: 10,
              last_run_at: '2026-02-14T14:00:00Z',
              created_at: '2026-01-15T00:00:00Z',
              mode: 'recipe',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('list_autopilot_configs')!;
      const result = await handler({ active_only: true });
      const text = result.content[0].text;
      expect(text).toContain('Autopilot Configurations (1)');
      expect(text).toContain('ID: cfg-active');
      expect(mockCallEdge).toHaveBeenCalledWith('mcp-data', {
        action: 'list-autopilot-configs',
        active_only: true,
      });
    });

    it('returns empty message when no configs found', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, configs: [] },
        error: null,
      });

      const handler = server.getHandler('list_autopilot_configs')!;
      const result = await handler({});
      expect(result.content[0].text).toContain('No autopilot configurations found');
      expect(result.isError).toBeUndefined();
    });

    it('returns isError on EF error', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Access denied. Check your account permissions.',
      });

      const handler = server.getHandler('list_autopilot_configs')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error fetching autopilot configs');
      expect(result.content[0].text).toContain('Access denied. Check your account permissions.');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          configs: [
            {
              id: 'cfg-333',
              recipe_id: 'r-3',
              is_active: true,
              schedule_config: { days: ['tue'], time: '10:00' },
              max_credits_per_run: 75,
              max_credits_per_week: 300,
              credits_used_this_week: 0,
              last_run_at: null,
              created_at: '2026-02-10T00:00:00Z',
              mode: 'recipe',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('list_autopilot_configs')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.2');
      expect(parsed._meta.timestamp).toBeDefined();
      expect(parsed.data).toHaveLength(1);
      expect(parsed.data[0].id).toBe('cfg-333');
    });
  });

  // =========================================================================
  // update_autopilot_config
  // =========================================================================
  describe('update_autopilot_config', () => {
    const TEST_CONFIG_ID = '550e8400-e29b-41d4-a716-446655440000';

    it('toggles is_active', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          updated: {
            id: TEST_CONFIG_ID,
            is_active: false,
            schedule_config: {},
            max_credits_per_run: 50,
          },
        },
        error: null,
      });

      const handler = server.getHandler('update_autopilot_config')!;
      const result = await handler({ config_id: TEST_CONFIG_ID, is_active: false });
      const text = result.content[0].text;
      expect(text).toContain(`Autopilot config ${TEST_CONFIG_ID} updated successfully`);
      expect(text).toContain('Active: false');
      expect(result.isError).toBeUndefined();
    });

    it('updates schedule via edge function', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          updated: {
            id: TEST_CONFIG_ID,
            is_active: true,
            schedule_config: { days: ['mon', 'fri'], time: '14:00' },
            max_credits_per_run: 100,
          },
        },
        error: null,
      });

      const handler = server.getHandler('update_autopilot_config')!;
      const result = await handler({
        config_id: TEST_CONFIG_ID,
        schedule_time: '14:00',
      });
      const text = result.content[0].text;
      expect(text).toContain('updated successfully');
    });

    it('returns no changes message when no fields provided', async () => {
      const handler = server.getHandler('update_autopilot_config')!;
      const result = await handler({ config_id: TEST_CONFIG_ID });
      expect(result.content[0].text).toContain('No changes specified');
      expect(result.content[0].text).toContain('Provide at least one field to update');
    });

    it('returns isError on EF error', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Database operation failed',
      });

      const handler = server.getHandler('update_autopilot_config')!;
      const result = await handler({
        config_id: TEST_CONFIG_ID,
        is_active: true,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error updating config');
      expect(result.content[0].text).toContain('Database operation failed');
    });

    it('sends config_id to edge function', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          updated: {
            id: TEST_CONFIG_ID,
            is_active: true,
            schedule_config: null,
            max_credits_per_run: 200,
          },
        },
        error: null,
      });

      const handler = server.getHandler('update_autopilot_config')!;
      await handler({ config_id: TEST_CONFIG_ID, max_credits_per_run: 200 });
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'update-autopilot-config',
          config_id: TEST_CONFIG_ID,
          max_credits_per_run: 200,
        })
      );
    });
  });

  // =========================================================================
  // get_autopilot_status
  // =========================================================================
  describe('get_autopilot_status', () => {
    it('returns active config count and pending approvals', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          activeConfigs: 2,
          pendingApprovals: 0,
          configs: [{ id: 'c1' }, { id: 'c2' }],
        },
        error: null,
      });

      const handler = server.getHandler('get_autopilot_status')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain('Active Configs: 2');
      expect(text).toContain('Pending Approvals: 0');
    });

    it('returns pending approvals count', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          activeConfigs: 1,
          pendingApprovals: 3,
          configs: [{ id: 'c1' }],
        },
        error: null,
      });

      const handler = server.getHandler('get_autopilot_status')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain('Pending Approvals: 3');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          activeConfigs: 1,
          pendingApprovals: 1,
          configs: [{ id: 'c1' }],
        },
        error: null,
      });

      const handler = server.getHandler('get_autopilot_status')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.2');
      expect(parsed._meta.timestamp).toBeDefined();
      expect(parsed.data.activeConfigs).toBe(1);
      expect(parsed.data.pendingApprovals).toBe(1);
    });

    it('handles zero active configs', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          activeConfigs: 0,
          pendingApprovals: 0,
          configs: [],
        },
        error: null,
      });

      const handler = server.getHandler('get_autopilot_status')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain('Active Configs: 0');
      expect(text).toContain('Pending Approvals: 0');
      expect(text).toContain('No recent runs.');
    });
  });

  // =========================================================================
  // create_autopilot_config
  // =========================================================================
  describe('create_autopilot_config', () => {
    const TEST_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000';

    it('creates a new autopilot config', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          created: {
            id: 'new-cfg-1',
            name: 'Weekly Pipeline',
            is_active: true,
            mode: 'pipeline',
            schedule_config: { days: ['mon', 'wed', 'fri'], time: '09:00', timezone: 'UTC' },
          },
        },
        error: null,
      });

      const handler = server.getHandler('create_autopilot_config')!;
      const result = await handler({
        name: 'Weekly Pipeline',
        project_id: TEST_PROJECT_ID,
        mode: 'pipeline',
        schedule_days: ['mon', 'wed', 'fri'],
        schedule_time: '09:00',
        approval_mode: 'review_low_confidence',
      });
      const text = result.content[0].text;
      expect(text).toContain('Autopilot config created');
      expect(text).toContain('Weekly Pipeline');
      expect(text).toContain('pipeline');
      expect(text).toContain('mon, wed, fri');
    });

    it('returns JSON format', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          created: {
            id: 'new-cfg-2',
            name: 'Test Config',
            is_active: true,
            mode: 'pipeline',
            schedule_config: { days: ['tue'], time: '14:00' },
          },
        },
        error: null,
      });

      const handler = server.getHandler('create_autopilot_config')!;
      const result = await handler({
        name: 'Test Config',
        project_id: TEST_PROJECT_ID,
        schedule_days: ['tue'],
        schedule_time: '14:00',
        approval_mode: 'auto',
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.7.2');
      expect(parsed.data.id).toBe('new-cfg-2');
    });

    it('returns isError on EF error', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'unique constraint violation',
      });

      const handler = server.getHandler('create_autopilot_config')!;
      const result = await handler({
        name: 'Duplicate',
        project_id: TEST_PROJECT_ID,
        schedule_days: ['mon'],
        schedule_time: '09:00',
        approval_mode: 'auto',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error creating autopilot config');
    });
  });
});
