import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerConnectionTools } from './connections.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId, resolveProjectForConnectedAccountTool } from '../lib/supabase.js';

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetProjectId = vi.mocked(getDefaultProjectId);
const mockResolveForAccountTool = vi.mocked(resolveProjectForConnectedAccountTool);

describe('connection tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerConnectionTools(server as any);
  });

  // =========================================================================
  // start_platform_connection
  // =========================================================================
  describe('start_platform_connection', () => {
    it('returns deep link + expiry for a valid platform', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          nonce: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          platform: 'Instagram',
          project_id: 'test-project-id',
          expires_at: '2026-04-25T20:00:00.000Z',
          deep_link:
            'https://www.socialneuron.com/settings/connections?start=instagram&t=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
        error: null,
      });

      const handler = server.getHandler('start_platform_connection')!;
      const result = await handler({ platform: 'instagram' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Instagram connection ready');
      expect(result.content[0].text).toContain(
        'https://www.socialneuron.com/settings/connections?start=instagram&t=aaaaaaaa'
      );
      expect(result.content[0].text).toContain('one-time browser setup');
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ action: 'mint-connection-nonce', platform: 'instagram' }),
        expect.objectContaining({ timeoutMs: 10_000 })
      );
    });

    it('returns JSON format with next-step guidance when requested', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          nonce: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          platform: 'TikTok',
          project_id: 'test-project-id',
          expires_at: '2026-04-25T20:00:00.000Z',
          deep_link: 'https://www.socialneuron.com/settings/connections?start=tiktok&t=xxx',
        },
        error: null,
      });

      const handler = server.getHandler('start_platform_connection')!;
      const result = await handler({ platform: 'tiktok', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.platform).toBe('TikTok');
      expect(parsed.deep_link).toMatch(/start=tiktok/);
      expect(parsed.next_step).toContain('wait_for_connection');
    });

    it('passes project_id when minting a brand-scoped connection link', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          nonce: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          platform: 'Twitter',
          project_id: 'vpn-project',
          expires_at: '2026-04-25T20:00:00.000Z',
          deep_link: 'https://www.socialneuron.com/settings/connections?start=twitter&t=xxx',
        },
        error: null,
      });

      const handler = server.getHandler('start_platform_connection')!;
      const result = await handler({ platform: 'twitter', project_id: 'vpn-project' });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Brand/project: vpn-project');
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'mint-connection-nonce',
          platform: 'twitter',
          projectId: 'vpn-project',
          project_id: 'vpn-project',
        }),
        expect.objectContaining({ timeoutMs: 10_000 })
      );
    });

    it('returns project_id in JSON connection link output', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          nonce: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          platform: 'Twitter',
          project_id: 'vpn-project',
          expires_at: '2026-04-25T20:00:00.000Z',
          deep_link: 'https://www.socialneuron.com/settings/connections?start=twitter&t=xxx',
        },
        error: null,
      });

      const handler = server.getHandler('start_platform_connection')!;
      const result = await handler({
        platform: 'twitter',
        project_id: 'vpn-project',
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.project_id).toBe('vpn-project');
    });

    it('surfaces EF errors cleanly', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Rate limit exceeded',
      });

      const handler = server.getHandler('start_platform_connection')!;
      const result = await handler({ platform: 'youtube' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to start youtube connection');
      expect(result.content[0].text).toContain('Rate limit exceeded');
    });

    it('handles success=false response from EF', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: false,
          nonce: '',
          platform: '',
          expires_at: '',
          deep_link: '',
          error: 'Unsupported platform: pinterest',
        },
        error: null,
      });

      const handler = server.getHandler('start_platform_connection')!;
      const result = await handler({ platform: 'instagram' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unsupported platform: pinterest');
    });

    // =========================================================================
    // P1 fix: starting a NEW connection must never auto-bind based on
    // whichever project happens to already own an unrelated account.
    // =========================================================================
    it('requires an explicit project_id when there is no sole accessible project — never uses the accounts-based auto-resolve', async () => {
      mockGetProjectId.mockResolvedValueOnce(null);

      const handler = server.getHandler('start_platform_connection')!;
      const result = await handler({ platform: 'instagram' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('project_id is required');
      expect(mockResolveForAccountTool).not.toHaveBeenCalled();
      expect(mockCallEdge).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // wait_for_connection
  // =========================================================================
  describe('wait_for_connection', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns connected account on first successful poll', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: 'acc-1',
              platform: 'Instagram',
              project_id: 'test-project-id',
              status: 'active',
              username: 'creator_a',
              created_at: '2026-04-25T19:55:00.000Z',
              expires_at: null,
              has_refresh_token: true,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('wait_for_connection')!;
      const result = await handler({ platform: 'instagram', poll_interval_s: 2 });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Instagram is connected');
      expect(result.content[0].text).toContain('creator_a');
    });

    it('returns JSON envelope when connected', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: 'acc-2',
              platform: 'YouTube',
              project_id: 'test-project-id',
              status: 'active',
              username: null,
              created_at: '2026-04-25T19:55:00.000Z',
              expires_at: null,
              has_refresh_token: false,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('wait_for_connection')!;
      const result = await handler({ platform: 'youtube', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.connected).toBe(true);
      expect(parsed.platform).toBe('YouTube');
      expect(parsed.account_id).toBe('acc-2');
      expect(parsed.attempts).toBe(1);
    });

    it('passes project_id while polling for a brand-scoped account', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: 'acc-brand',
              platform: 'Twitter',
              status: 'active',
              effective_status: 'active',
              username: 'thevpnmatrix',
              project_id: 'vpn-project',
              created_at: '2026-04-25T19:55:00.000Z',
              expires_at: null,
              has_refresh_token: true,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('wait_for_connection')!;
      const result = await handler({
        platform: 'twitter',
        project_id: 'vpn-project',
        poll_interval_s: 2,
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Brand/project: vpn-project');
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'connected-accounts',
          projectId: 'vpn-project',
          project_id: 'vpn-project',
        }),
        expect.objectContaining({ timeoutMs: 10_000 })
      );
    });

    it('treats inactive accounts as not yet connected', async () => {
      // First poll: inactive row, should keep waiting.
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: 'acc-3',
              platform: 'Instagram',
              project_id: 'test-project-id',
              status: 'expired',
              username: 'creator_b',
              created_at: '2026-04-20T00:00:00.000Z',
              expires_at: '2026-04-21T00:00:00.000Z',
              has_refresh_token: false,
            },
          ],
        },
        error: null,
      });
      // Second poll: now active.
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: 'acc-3',
              platform: 'Instagram',
              project_id: 'test-project-id',
              status: 'active',
              username: 'creator_b',
              created_at: '2026-04-25T19:58:00.000Z',
              expires_at: null,
              has_refresh_token: true,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('wait_for_connection')!;
      const promise = handler({ platform: 'instagram', timeout_s: 10, poll_interval_s: 2 });

      // Allow first poll to resolve, then advance timers past the interval.
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);

      const result = await promise;
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Instagram is connected');
      expect(mockCallEdge).toHaveBeenCalledTimes(2);
    });

    it('returns timeout message when connection never appears', async () => {
      mockCallEdge.mockResolvedValue({
        data: { success: true, accounts: [] },
        error: null,
      });

      const handler = server.getHandler('wait_for_connection')!;
      const promise = handler({ platform: 'tiktok', timeout_s: 5, poll_interval_s: 2 });

      // Drain ticks past the timeout deadline.
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2_000);
      }

      const result = await promise;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('did not connect within 5s');
      expect(result.content[0].text).toContain('start_platform_connection');
    });

    it('returns timeout JSON envelope', async () => {
      mockCallEdge.mockResolvedValue({
        data: { success: true, accounts: [] },
        error: null,
      });

      const handler = server.getHandler('wait_for_connection')!;
      const promise = handler({
        platform: 'youtube',
        timeout_s: 5,
        poll_interval_s: 2,
        response_format: 'json',
      });

      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2_000);
      }

      const result = await promise;
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.connected).toBe(false);
      expect(parsed.timed_out).toBe(true);
      expect(parsed.platform).toBe('youtube');
    });

    it('returns success-with-choice (not an error) when two accounts are already active for the platform', async () => {
      // F8 (2026-07-15): the OAuth flow succeeded — the platform IS
      // connected, just to two accounts. Previously this returned
      // isError:true, masking a successful connect behind an "error".
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: 'acc-1',
              platform: 'Instagram',
              project_id: 'test-project-id',
              status: 'active',
              username: 'brand-one',
              created_at: '2026-04-25T19:55:00.000Z',
              expires_at: null,
              has_refresh_token: true,
            },
            {
              id: 'acc-2',
              platform: 'Instagram',
              project_id: 'test-project-id',
              status: 'active',
              username: 'brand-two',
              created_at: '2026-04-25T19:56:00.000Z',
              expires_at: null,
              has_refresh_token: true,
            },
          ],
        },
        error: null,
      });

      const result = await server.getHandler('wait_for_connection')!({
        platform: 'instagram',
      });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('2 active accounts');
      expect(result.content[0].text).toContain('brand-one');
      expect(result.content[0].text).toContain('brand-two');
      expect(result.content[0].text).toContain('acc-1');
      expect(result.content[0].text).toContain('acc-2');
    });

    it('success-with-choice JSON format lists both accounts', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: 'acc-1',
              platform: 'Instagram',
              project_id: 'test-project-id',
              status: 'active',
              username: 'brand-one',
              created_at: '2026-04-25T19:55:00.000Z',
              expires_at: null,
              has_refresh_token: true,
            },
            {
              id: 'acc-2',
              platform: 'Instagram',
              project_id: 'test-project-id',
              status: 'active',
              username: 'brand-two',
              created_at: '2026-04-25T19:56:00.000Z',
              expires_at: null,
              has_refresh_token: true,
            },
          ],
        },
        error: null,
      });

      const result = await server.getHandler('wait_for_connection')!({
        platform: 'instagram',
        response_format: 'json',
      });

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.connected).toBe(true);
      expect(parsed.accounts).toHaveLength(2);
      expect(parsed.accounts.map((a: { id: string }) => a.id)).toEqual(['acc-1', 'acc-2']);
    });
  });
});
