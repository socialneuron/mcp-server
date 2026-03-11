import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerAutopilotTools } from './autopilot.js';
import { getSupabaseClient, getDefaultUserId } from '../lib/supabase.js';

const mockGetClient = vi.mocked(getSupabaseClient);
const mockGetUserId = vi.mocked(getDefaultUserId);

/** Build a chainable Supabase query mock that resolves to the given value. */
function chainMock(resolvedValue: { data: any; error: any } = { data: [], error: null }) {
  const c: Record<string, any> = {};
  const methods = [
    'select',
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'like',
    'ilike',
    'in',
    'or',
    'not',
    'is',
    'order',
    'limit',
    'range',
    'single',
    'maybeSingle',
    'filter',
    'match',
    'contains',
    'containedBy',
    'insert',
    'update',
    'delete',
    'upsert',
  ];
  for (const m of methods) c[m] = vi.fn().mockReturnValue(c);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  c.then = (resolve: Function) => resolve(resolvedValue);
  c.catch = () => c;
  c.finally = () => c;
  return c;
}

describe('autopilot tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerAutopilotTools(server as any);
    mockGetUserId.mockResolvedValue('test-user-id');
  });

  // =========================================================================
  // list_autopilot_configs
  // =========================================================================
  describe('list_autopilot_configs', () => {
    it('returns all configs for user in text format', async () => {
      const configsChain = chainMock({
        data: [
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
        error: null,
      });
      mockGetClient.mockReturnValue({ from: vi.fn(() => configsChain) } as any);

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

    it('returns only active configs when active_only=true', async () => {
      const configsChain = chainMock({
        data: [
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
        error: null,
      });
      mockGetClient.mockReturnValue({ from: vi.fn(() => configsChain) } as any);

      const handler = server.getHandler('list_autopilot_configs')!;
      const result = await handler({ active_only: true });
      const text = result.content[0].text;
      expect(text).toContain('Autopilot Configurations (1)');
      expect(text).toContain('ID: cfg-active');
      // Verify eq was called with is_active filter
      expect(configsChain.eq).toHaveBeenCalledWith('is_active', true);
    });

    it('returns empty message when no configs found', async () => {
      const configsChain = chainMock({ data: [], error: null });
      mockGetClient.mockReturnValue({ from: vi.fn(() => configsChain) } as any);

      const handler = server.getHandler('list_autopilot_configs')!;
      const result = await handler({});
      expect(result.content[0].text).toContain('No autopilot configurations found');
      expect(result.isError).toBeUndefined();
    });

    it('returns isError on DB error', async () => {
      const configsChain = chainMock({
        data: null,
        error: { message: 'permission denied for table autopilot_configs' },
      });
      mockGetClient.mockReturnValue({ from: vi.fn(() => configsChain) } as any);

      const handler = server.getHandler('list_autopilot_configs')!;
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error fetching autopilot configs');
      expect(result.content[0].text).toContain('Access denied. Check your account permissions.');
    });

    it('returns JSON envelope when response_format=json', async () => {
      const configsChain = chainMock({
        data: [
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
        error: null,
      });
      mockGetClient.mockReturnValue({ from: vi.fn(() => configsChain) } as any);

      const handler = server.getHandler('list_autopilot_configs')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.2.1');
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
      const configsChain = chainMock({
        data: {
          id: TEST_CONFIG_ID,
          is_active: false,
          schedule_config: {},
          max_credits_per_run: 50,
        },
        error: null,
      });
      mockGetClient.mockReturnValue({ from: vi.fn(() => configsChain) } as any);

      const handler = server.getHandler('update_autopilot_config')!;
      const result = await handler({ config_id: TEST_CONFIG_ID, is_active: false });
      const text = result.content[0].text;
      expect(text).toContain(`Autopilot config ${TEST_CONFIG_ID} updated successfully`);
      expect(text).toContain('Active: false');
      expect(result.isError).toBeUndefined();
    });

    it('updates schedule by merging with existing config', async () => {
      // The handler first fetches existing config, then updates
      // Both queries go through the same chainMock, so we need to handle
      // the select (for existing) and update (for changes) calls
      const configsChain = chainMock({
        data: {
          id: TEST_CONFIG_ID,
          is_active: true,
          schedule_config: { days: ['mon', 'fri'], time: '10:00' },
          max_credits_per_run: 100,
        },
        error: null,
      });
      mockGetClient.mockReturnValue({ from: vi.fn(() => configsChain) } as any);

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

    it('returns isError on DB update error', async () => {
      const configsChain = chainMock({
        data: null,
        error: { message: 'row not found' },
      });
      mockGetClient.mockReturnValue({ from: vi.fn(() => configsChain) } as any);

      const handler = server.getHandler('update_autopilot_config')!;
      const result = await handler({
        config_id: TEST_CONFIG_ID,
        is_active: true,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error updating config');
      expect(result.content[0].text).toContain('Database operation failed');
    });

    it('scopes update to user_id', async () => {
      const configsChain = chainMock({
        data: {
          id: TEST_CONFIG_ID,
          is_active: true,
          schedule_config: null,
          max_credits_per_run: 0,
        },
        error: null,
      });
      mockGetClient.mockReturnValue({ from: vi.fn(() => configsChain) } as any);

      const handler = server.getHandler('update_autopilot_config')!;
      await handler({ config_id: TEST_CONFIG_ID, max_credits_per_run: 200 });
      // The update chain calls .eq('user_id', ...) to scope to the user
      expect(configsChain.eq).toHaveBeenCalledWith('user_id', 'test-user-id');
      expect(configsChain.eq).toHaveBeenCalledWith('id', TEST_CONFIG_ID);
    });
  });

  // =========================================================================
  // get_autopilot_status
  // =========================================================================
  describe('get_autopilot_status', () => {
    it('returns active config count and recent runs', async () => {
      const configsChain = chainMock({
        data: [{ id: 'c1' }, { id: 'c2' }],
        error: null,
      });
      const runsChain = chainMock({
        data: [
          {
            id: 'run-abcdef12-0000-0000-0000-000000000000',
            status: 'completed',
            started_at: '2026-02-15T09:00:00Z',
            completed_at: '2026-02-15T09:05:00Z',
            credits_used: 25,
          },
        ],
        error: null,
      });
      const approvalsChain = chainMock({ data: [], error: null });

      const fromMock = vi.fn((table: string) => {
        if (table === 'autopilot_configs') return configsChain;
        if (table === 'recipe_runs') return runsChain;
        if (table === 'approval_queue') return approvalsChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock } as any);

      const handler = server.getHandler('get_autopilot_status')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain('Active Configs: 2');
      expect(text).toContain('Pending Approvals: 0');
      expect(text).toContain('Recent Runs:');
      expect(text).toContain('run-abcd');
      expect(text).toContain('completed');
    });

    it('returns pending approvals count', async () => {
      const configsChain = chainMock({ data: [{ id: 'c1' }], error: null });
      const runsChain = chainMock({ data: [], error: null });
      const approvalsChain = chainMock({
        data: [
          { id: 'a1', status: 'pending', created_at: '2026-02-16T12:00:00Z' },
          { id: 'a2', status: 'pending', created_at: '2026-02-16T13:00:00Z' },
          { id: 'a3', status: 'pending', created_at: '2026-02-16T14:00:00Z' },
        ],
        error: null,
      });

      const fromMock = vi.fn((table: string) => {
        if (table === 'autopilot_configs') return configsChain;
        if (table === 'recipe_runs') return runsChain;
        if (table === 'approval_queue') return approvalsChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock } as any);

      const handler = server.getHandler('get_autopilot_status')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain('Pending Approvals: 3');
    });

    it('returns JSON envelope when response_format=json', async () => {
      const configsChain = chainMock({ data: [{ id: 'c1' }], error: null });
      const runsChain = chainMock({
        data: [
          {
            id: 'run-99999999-0000-0000-0000-000000000000',
            status: 'running',
            started_at: '2026-02-17T08:00:00Z',
            completed_at: null,
            credits_used: 0,
          },
        ],
        error: null,
      });
      const approvalsChain = chainMock({ data: [{ id: 'a1' }], error: null });

      const fromMock = vi.fn((table: string) => {
        if (table === 'autopilot_configs') return configsChain;
        if (table === 'recipe_runs') return runsChain;
        if (table === 'approval_queue') return approvalsChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock } as any);

      const handler = server.getHandler('get_autopilot_status')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('1.2.1');
      expect(parsed._meta.timestamp).toBeDefined();
      expect(parsed.data.activeConfigs).toBe(1);
      expect(parsed.data.recentRuns).toHaveLength(1);
      expect(parsed.data.pendingApprovals).toBe(1);
    });

    it('handles no recent runs', async () => {
      const configsChain = chainMock({ data: [], error: null });
      const runsChain = chainMock({ data: [], error: null });
      const approvalsChain = chainMock({ data: [], error: null });

      const fromMock = vi.fn((table: string) => {
        if (table === 'autopilot_configs') return configsChain;
        if (table === 'recipe_runs') return runsChain;
        if (table === 'approval_queue') return approvalsChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock } as any);

      const handler = server.getHandler('get_autopilot_status')!;
      const result = await handler({});
      const text = result.content[0].text;
      expect(text).toContain('Active Configs: 0');
      expect(text).toContain('Pending Approvals: 0');
      expect(text).toContain('No recent runs.');
      expect(text).not.toContain('Recent Runs:');
    });
  });
});
