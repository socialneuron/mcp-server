import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerDistributionTools } from './distribution.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId, getDefaultUserId } from '../lib/supabase.js';
import { MCP_VERSION } from '../lib/version.js';

// Stub SSRF so tests against fictional hosts (example.com variants, r2-signed.example.com)
// don't actually resolve DNS. Individual tests override for rejection cases.
vi.mock('../lib/ssrf.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/ssrf.js')>('../lib/ssrf.js');
  return {
    ...actual,
    validateUrlForSSRF: vi.fn(async (url: string) => {
      // Reject the same patterns the real validator would, using synchronous
      // heuristics (IP literals, non-https, credentials). For anything else,
      // pass through with a stable sanitized URL.
      try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') {
          return { isValid: false, error: `Invalid protocol: ${u.protocol}` };
        }
        if (u.username || u.password) {
          return { isValid: false, error: 'URL contains credentials' };
        }
        // Block private-range IP literals explicitly.
        if (
          /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(u.hostname) ||
          u.hostname === 'localhost'
        ) {
          return { isValid: false, error: `Private/metadata IP: ${u.hostname}` };
        }
        return { isValid: true, sanitizedUrl: url, resolvedIP: '203.0.113.1' };
      } catch {
        return { isValid: false, error: 'Invalid URL' };
      }
    }),
  };
});

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetUserId = vi.mocked(getDefaultUserId);
const mockGetProjectId = vi.mocked(getDefaultProjectId);

describe('distribution tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserId.mockResolvedValue('user-1');
    mockGetProjectId.mockResolvedValue('11111111-1111-4111-8111-111111111111');
    server = createMockServer();
    registerDistributionTools(server as any);
  });

  // =========================================================================
  // schedule_post
  // =========================================================================
  describe('schedule_post', () => {
    // Helper: build a connected_accounts preflight response with active accounts for given platforms
    const mockPreflightAccounts = (
      platforms: string[],
      projectId = '11111111-1111-4111-8111-111111111111'
    ) => ({
      data: {
        accounts: platforms.map((p, i) => ({
          id: `acct-${i}`,
          platform: p,
          project_id: projectId,
          username: `user-${p.toLowerCase()}`,
          status: 'active',
          expires_at: null,
          has_refresh_token: true,
        })),
      },
      error: null,
    });

    it('normalizes platform names to capitalized convention', async () => {
      mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['YouTube', 'TikTok']));
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, results: {}, scheduledAt: '2026-03-01T12:00:00Z' },
        error: null,
      });

      const handler = server.getHandler('schedule_post')!;
      await handler({
        media_url: 'https://example.com/video.mp4',
        caption: 'Test post',
        platforms: ['youtube', 'tiktok'],
        auto_rehost: false,
      });

      expect(mockCallEdge).toHaveBeenCalledTimes(2);
      // Second call is the actual schedule-post EF
      const callArgs = mockCallEdge.mock.calls[1];
      expect(callArgs[0]).toBe('schedule-post');
      expect(callArgs[1].platforms).toEqual(['YouTube', 'TikTok']);
      expect(callArgs[1].mediaType).toBe('VIDEO');
      expect(callArgs[1]).toEqual(
        expect.objectContaining({
          projectId: '11111111-1111-4111-8111-111111111111',
          project_id: '11111111-1111-4111-8111-111111111111',
          connectedAccountIds: { YouTube: 'acct-0', TikTok: 'acct-1' },
        })
      );
    });

    // =========================================================================
    // account_id/account_ids auto-bind (E3, 2026-07-15)
    // =========================================================================
    it('auto-binds when omitted and exactly one active account exists for the platform', async () => {
      mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['TikTok']));
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, results: {}, scheduledAt: '2026-03-01T12:00:00Z' },
        error: null,
      });

      const handler = server.getHandler('schedule_post')!;
      const result = await handler({
        media_url: 'https://example.com/video.mp4',
        caption: 'Test post',
        platforms: ['tiktok'],
        auto_rehost: false,
      });

      expect(result.isError).toBe(false);
      const callArgs = mockCallEdge.mock.calls[1];
      expect(callArgs[1].connectedAccountIds).toEqual({ TikTok: 'acct-0' });
    });

    it('fails closed with a clear error when neither account_id nor account_ids is given and 2+ accounts exist', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          accounts: [
            {
              id: 'acct-tiktok-1',
              platform: 'TikTok',
              project_id: '11111111-1111-4111-8111-111111111111',
              username: 'brand-one',
              status: 'active',
              expires_at: null,
              has_refresh_token: true,
            },
            {
              id: 'acct-tiktok-2',
              platform: 'TikTok',
              project_id: '11111111-1111-4111-8111-111111111111',
              username: 'brand-two',
              status: 'active',
              expires_at: null,
              has_refresh_token: true,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('schedule_post')!;
      const result = await handler({
        media_url: 'https://example.com/video.mp4',
        caption: 'Test post',
        platforms: ['tiktok'],
        auto_rehost: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('multiple active accounts');
      // The schedule-post EF must never be called when routing is ambiguous.
      expect(mockCallEdge).toHaveBeenCalledTimes(1);
    });

    it('maps snake_case params to camelCase in edge function body', async () => {
      mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['Instagram'], 'proj-123'));
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, results: {}, scheduledAt: '2026-03-15T14:00:00Z' },
        error: null,
      });

      const handler = server.getHandler('schedule_post')!;
      await handler({
        media_url: 'https://cdn.example.com/img.png',
        caption: 'Hello world',
        platforms: ['instagram'],
        title: 'My Post',
        hashtags: ['ai', 'social'],
        schedule_at: '2026-03-15T14:00:00Z',
        project_id: 'proj-123',
        auto_rehost: false,
      });

      // Second call (index 1) is schedule-post; first is the connected-accounts preflight
      const body = mockCallEdge.mock.calls[1][1];
      expect(body).toEqual(
        expect.objectContaining({
          mediaUrl: 'https://cdn.example.com/img.png',
          mediaType: 'IMAGE',
          caption: 'Hello world',
          platforms: ['Instagram'],
          title: 'My Post',
          hashtags: ['ai', 'social'],
          scheduledAt: '2026-03-15T14:00:00Z',
          projectId: 'proj-123',
        })
      );
    });

    it('forwards YouTube synthetic-media disclosure and idempotency safely', async () => {
      mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['YouTube']));
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, results: {}, scheduledAt: '2026-08-15T14:00:00Z' },
        error: null,
      });

      const handler = server.getHandler('schedule_post')!;
      await handler({
        media_url: 'https://cdn.example.com/audit.mp4',
        media_type: 'VIDEO',
        caption: 'Audit upload',
        platforms: ['youtube'],
        schedule_at: '2026-08-15T14:00:00Z',
        idempotency_key: 'audit-youtube-20260815',
        platform_metadata: {
          youtube: {
            privacy_status: 'private',
            made_for_kids: false,
            notify_subscribers: false,
            contains_synthetic_media: true,
          },
        },
        auto_rehost: false,
      });

      const body = mockCallEdge.mock.calls[1][1];
      expect(body.idempotencyKey).toBe('audit-youtube-20260815');
      expect(body.platformMetadata).toEqual({
        youtube: {
          privacyStatus: 'private',
          madeForKids: false,
          notifySubscribers: false,
          containsSyntheticMedia: true,
        },
      });
      expect(body).not.toHaveProperty('visualGateResult');
      expect(body).not.toHaveProperty('origin');
      expect(body).not.toHaveProperty('hermesRunId');
    });

    it('derives and always sends an idempotency key when none is provided (P1-8)', async () => {
      // A 30s client timeout + agent retry used to mint a duplicate live
      // publish. The tool now derives a stable key from the logical request,
      // so identical retries collapse server-side.
      const invoke = async () => {
        mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['YouTube']));
        mockCallEdge.mockResolvedValueOnce({
          data: { success: true, results: {}, scheduledAt: '2026-08-15T14:00:00Z' },
          error: null,
        });
        const handler = server.getHandler('schedule_post')!;
        await handler({
          media_url: 'https://cdn.example.com/audit.mp4',
          media_type: 'VIDEO',
          caption: 'Audit upload',
          platforms: ['youtube'],
          schedule_at: '2026-08-15T14:00:00Z',
          auto_rehost: false,
        });
        return mockCallEdge.mock.calls[mockCallEdge.mock.calls.length - 1][1] as {
          idempotencyKey?: string;
        };
      };

      const first = await invoke();
      const second = await invoke();
      expect(first.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
      // Stable: the same logical request derives the same key on retry.
      expect(second.idempotencyKey).toBe(first.idempotencyKey);
    });

    it('defaults platform AI disclosures on and preserves explicit false', async () => {
      mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['TikTok', 'Instagram', 'YouTube']));
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, results: {}, scheduledAt: '2026-08-15T14:00:00Z' },
        error: null,
      });

      const handler = server.getHandler('schedule_post')!;
      await handler({
        media_url: 'https://cdn.example.com/audit.mp4',
        media_type: 'VIDEO',
        caption: 'Audit upload',
        title: 'Audit upload',
        platforms: ['tiktok', 'instagram', 'youtube'],
        platform_metadata: { instagram: { is_ai_generated: false } },
        auto_rehost: false,
      });

      const body = mockCallEdge.mock.calls[1][1] as Record<string, any>;
      expect(body.platformMetadata.tiktok.isAiGenerated).toBe(true);
      expect(body.platformMetadata.tiktok.useInbox).toBeUndefined();
      expect(body.platformMetadata.instagram.isAiGenerated).toBe(false);
      expect(body.platformMetadata.youtube.containsSyntheticMedia).toBe(true);
    });

    it('rejects ambiguous media instead of bypassing the visual gate with an undefined type', async () => {
      const handler = server.getHandler('schedule_post')!;
      const result = await handler({
        media_url: 'https://cdn.example.com/download',
        caption: 'Ambiguous media',
        platforms: ['youtube'],
        auto_rehost: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('media_type is required');
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('scopes account preflight by project_id and rejects account IDs outside that brand', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          accounts: [
            {
              id: 'vpn-twitter',
              platform: 'Twitter',
              status: 'active',
              effective_status: 'active',
              username: 'thevpnmatrix',
              created_at: '2026-06-01T00:00:00Z',
              project_id: 'vpn-project',
              expires_at: null,
              has_refresh_token: true,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('schedule_post')!;
      const result = await handler({
        media_url: 'https://example.com/post.png',
        caption: 'VPN Matrix post',
        platforms: ['twitter'],
        project_id: 'vpn-project',
        account_id: 'social-neuron-twitter',
        auto_rehost: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('social-neuron-twitter');
      expect(result.content[0].text).toContain('project_id vpn-project');
      expect(mockCallEdge).toHaveBeenCalledTimes(1);
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'connected-accounts',
          projectId: 'vpn-project',
          project_id: 'vpn-project',
        }),
        expect.any(Object)
      );
    });

    it('fails closed when account inventory verification errors', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: null, error: 'inventory unavailable' });

      const result = await server.getHandler('schedule_post')!({
        media_url: 'https://example.com/post.png',
        caption: 'Do not route by guess',
        platforms: ['instagram'],
        auto_rehost: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Connected-account verification failed');
      expect(result.content[0].text).toContain('inventory unavailable');
      expect(mockCallEdge.mock.calls.some(call => call[0] === 'schedule-post')).toBe(false);
    });

    it('rejects unassigned accounts even when the backend returns them for a project query', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          accounts: [
            {
              id: 'unassigned-instagram',
              platform: 'Instagram',
              project_id: null,
              status: 'active',
            },
          ],
        },
        error: null,
      });

      const result = await server.getHandler('schedule_post')!({
        media_url: 'https://example.com/post.png',
        caption: 'Do not use an unassigned account',
        platforms: ['instagram'],
        account_id: 'unassigned-instagram',
        auto_rehost: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not bound to project_id');
      expect(mockCallEdge.mock.calls.some(call => call[0] === 'schedule-post')).toBe(false);
    });

    it('rejects conflicting account_id and account_ids before any API call', async () => {
      const result = await server.getHandler('schedule_post')!({
        media_url: 'https://example.com/post.png',
        caption: 'Ambiguous route',
        platforms: ['instagram'],
        account_id: 'account-one',
        account_ids: { instagram: 'account-two' },
        auto_rehost: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('either account_id or account_ids');
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('returns formatted success text with platform results', async () => {
      mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['YouTube', 'TikTok']));
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          scheduledAt: '2026-03-01T12:00:00Z',
          results: {
            YouTube: { success: true, jobId: 'j1', postId: 'p1' },
            TikTok: { success: false, error: 'Token expired' },
          },
        },
        error: null,
      });

      const handler = server.getHandler('schedule_post')!;
      const result = await handler({
        media_url: 'https://example.com/v.mp4',
        caption: 'Cap',
        platforms: ['youtube', 'tiktok'],
        auto_rehost: false,
      });

      const text = result.content[0].text;
      expect(text).toContain('Post scheduled successfully.');
      expect(text).toContain('YouTube: OK (jobId=j1, postId=p1)');
      expect(text).toContain('TikTok: FAILED - Token expired');
      expect(result.isError).toBe(false);
    });

    it('returns isError true on edge function failure', async () => {
      mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['YouTube']));
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Network timeout',
      });

      const handler = server.getHandler('schedule_post')!;
      const result = await handler({
        media_url: 'https://example.com/v.mp4',
        caption: 'Cap',
        platforms: ['youtube'],
        auto_rehost: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to schedule post');
      expect(result.content[0].text).toContain('Network timeout');
    });

    // Phase 5 (2026-07-18): TikTok compliance parity. The schedule-post EF gate
    // rejects a TikTok post with no privacy_status and no use_inbox via a
    // structured 400 { code, error }. callEdgeFunction surfaces "CODE: message";
    // the tool must relay it as a clean tool error (isError), NOT throw a 500 or
    // collapse it into a generic failure — so the agent can self-correct.
    it('surfaces the TikTok privacy-required compliance error as a structured tool error', async () => {
      mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['TikTok']));
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error:
          'TIKTOK_PRIVACY_LEVEL_REQUIRED: TikTok requires a privacy level to be selected. Please choose a privacy level before posting.',
      });

      const handler = server.getHandler('schedule_post')!;
      const result = await handler({
        media_url: 'https://example.com/v.mp4',
        caption: 'Cap',
        platforms: ['tiktok'],
        platform_metadata: { tiktok: { is_ai_generated: true } },
        auto_rehost: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('TIKTOK_PRIVACY_LEVEL_REQUIRED');
      expect(result.content[0].text).toContain('Failed to schedule post');
    });

    it('surfaces the TikTok branded/SELF_ONLY conflict compliance error', async () => {
      mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['TikTok']));
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error:
          'TIKTOK_BRANDED_SELF_ONLY_CONFLICT: Branded content visibility cannot be set to private on TikTok. Please select a different privacy level.',
      });

      const handler = server.getHandler('schedule_post')!;
      const result = await handler({
        media_url: 'https://example.com/v.mp4',
        caption: 'Cap',
        platforms: ['tiktok'],
        platform_metadata: {
          tiktok: { privacy_status: 'SELF_ONLY', brand_content: true, use_inbox: false },
        },
        auto_rehost: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('TIKTOK_BRANDED_SELF_ONLY_CONFLICT');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['YouTube']));
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          scheduledAt: '2026-03-01T12:00:00Z',
          results: { YouTube: { success: true } },
        },
        error: null,
      });

      const handler = server.getHandler('schedule_post')!;
      const result = await handler({
        media_url: 'https://example.com/v.mp4',
        caption: 'Cap',
        platforms: ['youtube'],
        response_format: 'json',
        auto_rehost: false,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe(MCP_VERSION);
      expect(parsed.data.success).toBe(true);
    });

    // =======================================================================
    // auto_rehost (URL -> R2 persistence)
    // =======================================================================
    describe('auto_rehost', () => {
      it('rehosts external media_url via upload-to-r2 before posting', async () => {
        mockCallEdge
          .mockResolvedValueOnce({
            data: {
              success: true,
              url: 'https://r2-signed.example.com/org_1/user_1/rehosted.png?X-Amz-Signature=abc',
              key: 'org_1/user_1/images/2026-04-21/rehosted.png',
              size: 512000,
              contentType: 'image/png',
            },
            error: null,
          })
          .mockResolvedValueOnce(mockPreflightAccounts(['YouTube']))
          .mockResolvedValueOnce({
            data: {
              success: true,
              scheduledAt: '2026-04-21T14:00:00Z',
              results: { YouTube: { success: true, jobId: 'j1', postId: 'p1' } },
            },
            error: null,
          });

        const handler = server.getHandler('schedule_post')!;
        const result = await handler({
          media_url: 'https://replicate.delivery/xyz/ephemeral.png',
          caption: 'hi',
          platforms: ['youtube'],
        });

        expect(result.isError).toBe(false);
        expect(mockCallEdge).toHaveBeenNthCalledWith(
          1,
          'upload-to-r2',
          expect.objectContaining({ url: 'https://replicate.delivery/xyz/ephemeral.png' }),
          expect.any(Object)
        );
        const scheduleCall = mockCallEdge.mock.calls.find(c => c[0] === 'schedule-post');
        expect(scheduleCall).toBeDefined();
        expect(scheduleCall![1]).toEqual(
          expect.objectContaining({
            mediaUrl: 'https://r2-signed.example.com/org_1/user_1/rehosted.png?X-Amz-Signature=abc',
          })
        );
      });

      it('does not trust an X-Amz-Signature query parameter as R2 provenance', async () => {
        mockCallEdge
          .mockResolvedValueOnce({
            data: {
              success: true,
              url: 'https://r2-signed.example.com/org_1/user_1/rehosted.png?X-Amz-Signature=server',
              key: 'org_1/user_1/images/2026-04-21/rehosted.png',
              size: 512000,
              contentType: 'image/png',
            },
            error: null,
          })
          .mockResolvedValueOnce(mockPreflightAccounts(['YouTube']))
          .mockResolvedValueOnce({
            data: {
              success: true,
              scheduledAt: '2026-04-21T14:00:00Z',
              results: { YouTube: { success: true } },
            },
            error: null,
          });

        const handler = server.getHandler('schedule_post')!;
        const result = await handler({
          media_url: 'https://r2.example.com/key.png?X-Amz-Signature=deadbeef',
          caption: 'hi',
          platforms: ['youtube'],
        });

        expect(result.isError).toBe(false);
        expect(mockCallEdge.mock.calls.some(c => c[0] === 'upload-to-r2')).toBe(true);
        const scheduleCall = mockCallEdge.mock.calls.find(c => c[0] === 'schedule-post');
        expect(scheduleCall?.[1]).toEqual(
          expect.objectContaining({
            mediaUrl:
              'https://r2-signed.example.com/org_1/user_1/rehosted.png?X-Amz-Signature=server',
          })
        );
      });

      it('skips rehost entirely when auto_rehost=false', async () => {
        mockCallEdge
          .mockResolvedValueOnce(mockPreflightAccounts(['YouTube']))
          .mockResolvedValueOnce({
            data: {
              success: true,
              scheduledAt: '2026-04-21T14:00:00Z',
              results: { YouTube: { success: true } },
            },
            error: null,
          });

        const handler = server.getHandler('schedule_post')!;
        await handler({
          media_url: 'https://replicate.delivery/xyz/ephemeral.png',
          caption: 'hi',
          platforms: ['youtube'],
          auto_rehost: false,
        });

        expect(mockCallEdge.mock.calls.some(c => c[0] === 'upload-to-r2')).toBe(false);
      });

      it('rejects media_url that fails the SSRF guard (localhost)', async () => {
        const handler = server.getHandler('schedule_post')!;
        const result = await handler({
          media_url: 'http://localhost:8080/steal.png',
          caption: 'hi',
          platforms: ['youtube'],
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Failed to persist media URL');
        expect(mockCallEdge).not.toHaveBeenCalled();
      });

      it('rejects media_url pointing at the AWS metadata endpoint', async () => {
        const handler = server.getHandler('schedule_post')!;
        const result = await handler({
          media_url: 'http://169.254.169.254/latest/meta-data/',
          caption: 'hi',
          platforms: ['youtube'],
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Failed to persist media URL');
        expect(mockCallEdge).not.toHaveBeenCalled();
      });

      it('rejects SSRF attempt disguised with X-Amz-Signature query param', async () => {
        // Regression: the isAlreadyR2Signed() short-circuit previously fired
        // BEFORE the SSRF check, so an attacker could append ?X-Amz-Signature=x
        // to an internal URL and slip past both the check and the rehost.
        const handler = server.getHandler('schedule_post')!;
        const result = await handler({
          media_url: 'http://169.254.169.254/latest/meta-data/?X-Amz-Signature=forged',
          caption: 'hi',
          platforms: ['youtube'],
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Failed to persist media URL');
        // Critical: the spoofed URL must NOT be forwarded to schedule-post.
        expect(mockCallEdge).not.toHaveBeenCalled();
      });

      it('rejects non-https protocols (data:, file:, ftp:)', async () => {
        const handler = server.getHandler('schedule_post')!;
        for (const badUrl of [
          'file:///etc/passwd',
          'ftp://example.com/a.png',
          'data:image/png;base64,AAAA',
        ]) {
          mockCallEdge.mockClear();
          const result = await handler({
            media_url: badUrl,
            caption: 'hi',
            platforms: ['youtube'],
          });
          expect(result.isError).toBe(true);
          expect(mockCallEdge).not.toHaveBeenCalled();
        }
      });

      it('surfaces a useful error when the rehost EF fails', async () => {
        mockCallEdge.mockResolvedValueOnce({
          data: null,
          error: 'R2 quota exceeded',
        });

        const handler = server.getHandler('schedule_post')!;
        const result = await handler({
          media_url: 'https://replicate.delivery/xyz/ephemeral.png',
          caption: 'hi',
          platforms: ['youtube'],
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Failed to persist media URL');
        expect(result.content[0].text).toContain('R2 quota exceeded');
        expect(result.content[0].text).toContain('upload_media');
      });

      it('rehosts every URL in media_urls for carousels', async () => {
        // 3 rehost calls, then preflight, then schedule-post
        for (let i = 0; i < 3; i++) {
          mockCallEdge.mockResolvedValueOnce({
            data: {
              success: true,
              url: `https://r2-signed.example.com/k${i}.png?X-Amz-Signature=s${i}`,
              key: `org_1/user_1/images/2026-04-21/k${i}.png`,
              size: 1000,
              contentType: 'image/png',
            },
            error: null,
          });
        }
        mockCallEdge.mockResolvedValueOnce(mockPreflightAccounts(['Instagram']));
        mockCallEdge.mockResolvedValueOnce({
          data: {
            success: true,
            scheduledAt: '2026-04-21T14:00:00Z',
            results: { Instagram: { success: true } },
          },
          error: null,
        });

        const handler = server.getHandler('schedule_post')!;
        const result = await handler({
          media_urls: [
            'https://replicate.delivery/a.png',
            'https://replicate.delivery/b.png',
            'https://replicate.delivery/c.png',
          ],
          caption: 'carousel',
          platforms: ['instagram'],
          media_type: 'CAROUSEL_ALBUM',
        });

        expect(result.isError).toBe(false);
        // Exactly 3 upload-to-r2 calls
        const uploads = mockCallEdge.mock.calls.filter(c => c[0] === 'upload-to-r2');
        expect(uploads).toHaveLength(3);
        const scheduleCall = mockCallEdge.mock.calls.find(c => c[0] === 'schedule-post');
        expect(scheduleCall).toBeDefined();
        const schedBody = scheduleCall![1] as { mediaUrls: string[] };
        expect(schedBody.mediaUrls).toHaveLength(3);
        schedBody.mediaUrls.forEach((u: string) => {
          expect(u).toContain('X-Amz-Signature');
        });
      });

      it('rehosts a raw (non-R2) result_url returned by a kie.ai job_id', async () => {
        // kie.ai job that returned an ephemeral CDN URL rather than an R2 key
        mockCallEdge
          .mockResolvedValueOnce({
            data: {
              success: true,
              job: {
                result_url: 'https://tempfile.kie.ai/abc/generated.mp4',
                status: 'completed',
              },
            },
            error: null,
          })
          .mockResolvedValueOnce({
            data: {
              success: true,
              url: 'https://r2-signed.example.com/k.mp4?X-Amz-Signature=sig',
              key: 'org_1/user_1/videos/2026-04-21/k.mp4',
              size: 2_000_000,
              contentType: 'video/mp4',
            },
            error: null,
          })
          .mockResolvedValueOnce(mockPreflightAccounts(['YouTube']))
          .mockResolvedValueOnce({
            data: {
              success: true,
              scheduledAt: '2026-04-21T14:00:00Z',
              results: { YouTube: { success: true, jobId: 'j1', postId: 'p1' } },
            },
            error: null,
          });

        const handler = server.getHandler('schedule_post')!;
        const result = await handler({
          job_id: 'kie-job-123',
          caption: 'ai-made',
          platforms: ['youtube'],
        });

        expect(result.isError).toBe(false);
        const callNames = mockCallEdge.mock.calls.map(c => c[0]);
        expect(callNames[0]).toBe('mcp-data'); // job-status lookup
        expect(callNames[1]).toBe('upload-to-r2'); // rehost
        const uploadCall = mockCallEdge.mock.calls[1];
        expect(uploadCall[1]).toEqual(
          expect.objectContaining({ url: 'https://tempfile.kie.ai/abc/generated.mp4' })
        );
        const scheduleCall = mockCallEdge.mock.calls.find(c => c[0] === 'schedule-post');
        expect(scheduleCall).toBeDefined();
        expect(scheduleCall![1]).toEqual(
          expect.objectContaining({
            mediaUrl: 'https://r2-signed.example.com/k.mp4?X-Amz-Signature=sig',
          })
        );
      });

      it('does not rehost a kie.ai job_id that already resolved to an R2 key', async () => {
        // R2 key path: mcp-data returns r2_key (no http prefix) -> signR2Key ->
        // already R2-signed -> no rehost needed.
        mockCallEdge
          .mockResolvedValueOnce({
            data: {
              success: true,
              job: {
                result_url: 'org_1/user_1/videos/2026-04-21/k.mp4',
                status: 'completed',
              },
            },
            error: null,
          })
          .mockResolvedValueOnce({
            data: { signedUrl: 'https://r2.example.com/k.mp4?X-Amz-Signature=sig' },
            error: null,
          })
          .mockResolvedValueOnce(mockPreflightAccounts(['YouTube']))
          .mockResolvedValueOnce({
            data: {
              success: true,
              scheduledAt: '2026-04-21T14:00:00Z',
              results: { YouTube: { success: true } },
            },
            error: null,
          });

        const handler = server.getHandler('schedule_post')!;
        const result = await handler({
          job_id: 'kie-job-456',
          caption: 'from-r2',
          platforms: ['youtube'],
        });

        expect(result.isError).toBe(false);
        // No upload-to-r2 call
        expect(mockCallEdge.mock.calls.some(c => c[0] === 'upload-to-r2')).toBe(false);
      });

      it('does not rehost when r2_key is already provided', async () => {
        mockCallEdge
          .mockResolvedValueOnce({
            data: { signedUrl: 'https://r2.example.com/object?X-Amz-Signature=sig' },
            error: null,
          })
          .mockResolvedValueOnce(mockPreflightAccounts(['YouTube']))
          .mockResolvedValueOnce({
            data: {
              success: true,
              scheduledAt: '2026-04-21T14:00:00Z',
              results: { YouTube: { success: true } },
            },
            error: null,
          });

        const handler = server.getHandler('schedule_post')!;
        const result = await handler({
          r2_key: 'org_1/user_1/images/2026-04-21/k.png',
          caption: 'hi',
          platforms: ['youtube'],
        });

        expect(result.isError).toBe(false);
        expect(mockCallEdge.mock.calls.some(c => c[0] === 'upload-to-r2')).toBe(false);
        expect(mockCallEdge.mock.calls[0][0]).toBe('get-signed-url');
        expect(mockCallEdge).toHaveBeenLastCalledWith(
          'schedule-post',
          expect.objectContaining({ mediaType: 'IMAGE' }),
          { timeoutMs: 30_000 }
        );
      });
    });
  });

  // =========================================================================
  // list_connected_accounts
  // =========================================================================
  describe('list_connected_accounts', () => {
    it('calls mcp-data EF with connected-accounts action', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: 'a1',
              platform: 'YouTube',
              project_id: '11111111-1111-4111-8111-111111111111',
              status: 'active',
              username: 'mychan',
              created_at: '2026-01-10T00:00:00Z',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('list_connected_accounts')!;
      await handler({});

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ action: 'connected-accounts' })
      );
    });

    it('returns lowercase platform names in output', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: 'a1',
              platform: 'YouTube',
              project_id: '11111111-1111-4111-8111-111111111111',
              status: 'active',
              username: 'mychannel',
              created_at: '2026-01-15T10:00:00Z',
            },
            {
              id: 'a2',
              platform: 'TikTok',
              project_id: '11111111-1111-4111-8111-111111111111',
              status: 'active',
              username: 'tikuser',
              created_at: '2026-02-01T08:00:00Z',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('list_connected_accounts')!;
      const result = await handler({});

      const text = result.content[0].text;
      expect(text).toContain('2 connected account(s)');
      expect(text).toContain('youtube: mychannel');
      expect(text).toContain('tiktok: tikuser');
    });

    it('passes project_id and includes account routing fields in text output', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: 'vpn-x',
              platform: 'Twitter',
              status: 'active',
              effective_status: 'active',
              username: 'thevpnmatrix',
              created_at: '2026-06-01T00:00:00Z',
              project_id: 'vpn-project',
              expires_at: null,
              has_refresh_token: true,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('list_connected_accounts')!;
      const result = await handler({ project_id: 'vpn-project' });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'connected-accounts',
          projectId: 'vpn-project',
          project_id: 'vpn-project',
        })
      );
      const text = result.content[0].text;
      expect(text).toContain('1 connected account(s) for project vpn-project');
      expect(text).toContain('twitter: thevpnmatrix');
      expect(text).toContain('id=vpn-x');
      expect(text).toContain('project_id=vpn-project');
    });

    it('returns "No connected accounts" message when empty', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, accounts: [] },
        error: null,
      });

      const handler = server.getHandler('list_connected_accounts')!;
      const result = await handler({});

      expect(result.content[0].text).toContain('No connected social media accounts found');
      expect(result.isError).toBeUndefined();
    });

    it('returns isError true on EF error', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Service temporarily unavailable',
      });

      const handler = server.getHandler('list_connected_accounts')!;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to list connected accounts');
    });

    it('allowlists public fields instead of relaying OAuth secrets or new backend fields', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          accounts: [
            {
              id: 'a-secret-test',
              platform: 'Instagram',
              project_id: '11111111-1111-4111-8111-111111111111',
              status: 'active',
              username: 'brand',
              created_at: '2026-07-14T00:00:00Z',
              access_token: 'must-not-leak',
              refresh_token: 'must-not-leak-either',
              provider_diagnostics: { raw: true },
            },
          ],
        },
        error: null,
      });

      const result = await server.getHandler('list_connected_accounts')!({
        response_format: 'json',
      });
      const text = result.content[0].text;
      expect(text).toContain('a-secret-test');
      expect(text).not.toContain('must-not-leak');
      expect(text).not.toContain('provider_diagnostics');
      expect(result.structuredContent).toBeDefined();
    });
  });

  // =========================================================================
  // list_recent_posts
  // =========================================================================
  describe('list_recent_posts', () => {
    it('calls mcp-data EF with recent-posts action', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          posts: [
            {
              id: 'p1',
              platform: 'YouTube',
              status: 'published',
              title: 'My Video',
              external_post_id: 'yt-123',
              published_at: '2026-02-08T12:00:00Z',
              scheduled_at: null,
              created_at: '2026-02-07T10:00:00Z',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('list_recent_posts')!;
      await handler({ days: 14 });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'recent-posts',
          days: 14,
          project_id: '11111111-1111-4111-8111-111111111111',
        })
      );
    });

    it('passes platform filter to mcp-data', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { success: true, posts: [] }, error: null });

      const handler = server.getHandler('list_recent_posts')!;
      await handler({ platform: 'instagram' });

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ platform: 'instagram' })
      );
    });

    it('maps status values to correct icons', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          posts: [
            {
              id: '1',
              platform: 'YouTube',
              status: 'published',
              title: 'Published Video',
              external_post_id: null,
              published_at: '2026-02-10T00:00:00Z',
              scheduled_at: null,
              created_at: '2026-02-09T00:00:00Z',
            },
            {
              id: '2',
              platform: 'Instagram',
              status: 'scheduled',
              title: 'Scheduled Post',
              external_post_id: null,
              published_at: null,
              scheduled_at: '2026-02-15T09:00:00Z',
              created_at: '2026-02-09T00:00:00Z',
            },
            {
              id: '3',
              platform: 'TikTok',
              status: 'draft',
              title: 'Draft Clip',
              external_post_id: null,
              published_at: null,
              scheduled_at: null,
              created_at: '2026-02-08T00:00:00Z',
            },
            {
              id: '4',
              platform: 'Twitter',
              status: 'failed',
              title: 'Failed Tweet',
              external_post_id: null,
              published_at: null,
              scheduled_at: null,
              created_at: '2026-02-08T00:00:00Z',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('list_recent_posts')!;
      const result = await handler({});

      const text = result.content[0].text;
      expect(text).toContain('[OK] [YouTube] Published Video');
      expect(text).toContain('[SCHEDULED] [Instagram] Scheduled Post');
      expect(text).toContain('[DRAFT] [TikTok] Draft Clip');
      expect(text).toContain('[FAILED] [Twitter] Failed Tweet');
    });

    it('returns empty message with correct lookback days', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: { success: true, posts: [] }, error: null });

      const handler = server.getHandler('list_recent_posts')!;
      const result = await handler({ days: 30, platform: 'linkedin', status: 'published' });

      const text = result.content[0].text;
      expect(text).toContain('No posts found in the last 30 days');
      expect(text).toContain('on linkedin');
      expect(text).toContain('with status "published"');
      expect(result.isError).toBeUndefined();
    });

    it('allowlists post fields and drops captions, tenant ids, and backend metadata', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          posts: [
            {
              id: 'post-public',
              platform: 'instagram',
              status: 'scheduled',
              title: 'Public title',
              external_post_id: null,
              published_at: null,
              scheduled_at: '2099-07-14T12:00:00Z',
              created_at: '2026-07-14T00:00:00Z',
              caption: 'private caption not requested',
              user_id: 'private-user-id',
              metadata: { provider_task_id: 'private-provider-id' },
            },
          ],
        },
        error: null,
      });

      const result = await server.getHandler('list_recent_posts')!({ response_format: 'json' });
      const text = result.content[0].text;
      expect(text).toContain('post-public');
      expect(text).not.toContain('private caption');
      expect(text).not.toContain('private-user-id');
      expect(text).not.toContain('private-provider-id');
    });
  });

  describe('reschedule_post', () => {
    it('calls the atomic project-scoped backend action with optimistic concurrency', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          post_id: '22222222-2222-4222-8222-222222222222',
          project_id: '11111111-1111-4111-8111-111111111111',
          previous_scheduled_at: '2099-07-14T12:00:00.000Z',
          scheduled_at: '2099-07-15T12:00:00.000Z',
        },
        error: null,
      });

      const result = await server.getHandler('reschedule_post')!({
        post_id: '22222222-2222-4222-8222-222222222222',
        project_id: '11111111-1111-4111-8111-111111111111',
        scheduled_at: '2099-07-15T12:00:00Z',
        expected_scheduled_at: '2099-07-14T12:00:00Z',
        response_format: 'json',
      });

      expect(result.isError).toBeUndefined();
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'reschedule-scheduled-post',
          post_id: '22222222-2222-4222-8222-222222222222',
          project_id: '11111111-1111-4111-8111-111111111111',
          scheduled_at: '2099-07-15T12:00:00.000Z',
          expected_scheduled_at: '2099-07-14T12:00:00.000Z',
        })
      );
    });

    it('reports stale-calendar conflicts without exposing backend details', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: false,
          error: 'schedule_conflict',
          current_scheduled_at: '2099-07-16T09:00:00Z',
          internal_sql: 'must-not-leak',
        },
        error: null,
      });
      const result = await server.getHandler('reschedule_post')!({
        post_id: '22222222-2222-4222-8222-222222222222',
        scheduled_at: '2099-07-15T12:00:00Z',
        expected_scheduled_at: '2099-07-14T12:00:00Z',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('changed in another client');
      expect(result.content[0].text).not.toContain('must-not-leak');
    });
  });

  // =========================================================================
  // schedule_content_plan
  // =========================================================================
  describe('schedule_content_plan', () => {
    /** Helper to mock callEdgeFunction for plan-related actions in sequence */
    function mockPlanEdgeCalls(
      planData: { data: any; error: any },
      approvalsData?: { data: any; error: any },
      safetyData?: { data: any; error: any },
      updateData?: { data: any; error: any }
    ) {
      mockCallEdge.mockImplementation(async (fn: string, body: any) => {
        if (fn === 'mcp-data' && body.action === 'get-content-plan') {
          return planData;
        }
        if (fn === 'mcp-data' && body.action === 'list-plan-approvals') {
          return approvalsData ?? { data: { success: true, items: [] }, error: null };
        }
        if (fn === 'mcp-data' && body.action === 'content-safety-settings') {
          return (
            safetyData ?? {
              data: {
                success: true,
                quality_threshold: undefined,
                custom_banned_terms: [],
                brand_avoid_patterns: [],
              },
              error: null,
            }
          );
        }
        if (fn === 'mcp-data' && body.action === 'connected-accounts') {
          return {
            data: {
              success: true,
              accounts: [
                {
                  id: 'twitter-account-1',
                  platform: 'Twitter',
                  project_id:
                    planData.data?.plan?.project_id ?? '11111111-1111-4111-8111-111111111111',
                  status: 'active',
                },
              ],
            },
            error: null,
          };
        }
        if (fn === 'mcp-data' && body.action === 'update-plan-status') {
          return updateData ?? { data: { success: true }, error: null };
        }
        if (fn === 'schedule-post') {
          return {
            data: {
              success: true,
              results: { Twitter: { success: true, postId: 'post-1', jobId: 'job-1' } },
              scheduledAt: '2026-03-20T10:00:00Z',
            },
            error: null,
          };
        }
        return { data: null, error: 'Unknown call' };
      });
    }

    it('filters to approved/edited posts when plan approvals exist', async () => {
      const planId = '11111111-1111-1111-1111-111111111111';
      const posts = [
        {
          id: 'day1-twitter-1',
          caption: 'Approved post caption with enough content to pass baseline checks.',
          platform: 'twitter',
          schedule_at: '2026-03-20T10:00:00Z',
          hashtags: ['#one'],
        },
        {
          id: 'day1-linkedin-1',
          caption: 'Original edited caption that should be replaced by edited_post.',
          platform: 'linkedin',
          schedule_at: '2026-03-20T12:00:00Z',
          hashtags: ['#two'],
        },
        {
          id: 'day1-facebook-1',
          caption: 'Rejected post should never be sent to schedule-post.',
          platform: 'facebook',
          schedule_at: '2026-03-20T14:00:00Z',
          hashtags: ['#three'],
        },
      ];

      mockPlanEdgeCalls(
        {
          data: { success: true, plan: { id: planId, plan_payload: { posts } } },
          error: null,
        },
        {
          data: {
            success: true,
            items: [
              { post_id: 'day1-twitter-1', status: 'approved', edited_post: null },
              {
                post_id: 'day1-linkedin-1',
                status: 'edited',
                edited_post: {
                  caption: 'Edited approved caption',
                  title: 'Edited Title',
                  hashtags: ['#edited'],
                },
              },
              { post_id: 'day1-facebook-1', status: 'rejected', edited_post: null },
            ],
          },
          error: null,
        }
      );

      const handler = server.getHandler('schedule_content_plan')!;
      const result = await handler({
        plan_id: planId,
        auto_slot: false,
        dry_run: true,
        enforce_quality: false,
        response_format: 'json',
      });

      expect(result.isError).toBe(false);
      const envelope = JSON.parse(result.content[0].text);
      const returnedPosts = envelope.data.posts as Array<{ id: string; caption: string }>;
      expect(returnedPosts).toHaveLength(2);
      expect(returnedPosts.map(p => p.id)).toContain('day1-twitter-1');
      expect(returnedPosts.map(p => p.id)).toContain('day1-linkedin-1');
      expect(returnedPosts.map(p => p.id)).not.toContain('day1-facebook-1');
      expect(returnedPosts.map(p => p.caption)).toContain('Edited approved caption');
      // Verify schedule-post was NOT called (dry_run)
      const schedulePostCalls = mockCallEdge.mock.calls.filter(c => c[0] === 'schedule-post');
      expect(schedulePostCalls).toHaveLength(0);
    });

    it('fails CLOSED when the approvals lookup returns a non-success/malformed response (P1-7)', async () => {
      const planId = '11111111-1111-1111-1111-111111111111';
      mockPlanEdgeCalls(
        {
          data: {
            success: true,
            plan: {
              id: planId,
              plan_payload: {
                posts: [
                  {
                    id: 'p1',
                    caption: 'A caption long enough to pass baseline validation checks.',
                    platform: 'twitter',
                    schedule_at: '2026-03-20T10:00:00Z',
                  },
                ],
              },
            },
          },
          error: null,
        },
        // Approvals EF replies 200 but success:false / missing items — the old
        // code treated this as "no approvals" and scheduled everything.
        { data: { success: false }, error: null }
      );

      const handler = server.getHandler('schedule_content_plan')!;
      const result = await handler({
        plan_id: planId,
        auto_slot: false,
        dry_run: true,
        enforce_quality: false,
        response_format: 'json',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Could not verify plan approvals/);
    });

    it('fails CLOSED when content-safety settings cannot be loaded (P1-7)', async () => {
      const planId = '11111111-1111-1111-1111-111111111111';
      mockPlanEdgeCalls(
        {
          data: {
            success: true,
            plan: {
              id: planId,
              project_id: '22222222-2222-4222-8222-222222222222',
              plan_payload: {
                posts: [
                  {
                    id: 'p1',
                    caption: 'A caption long enough to pass baseline validation checks.',
                    platform: 'twitter',
                    schedule_at: '2026-03-20T10:00:00Z',
                  },
                ],
              },
            },
          },
          error: null,
        },
        { data: { success: true, items: [] }, error: null },
        // Safety settings EF errors — the old code swallowed this and fell
        // back to default safety config (no banned terms, default threshold).
        { data: null, error: 'EF timeout' }
      );

      const handler = server.getHandler('schedule_content_plan')!;
      const result = await handler({
        plan_id: planId,
        auto_slot: false,
        dry_run: true,
        enforce_quality: false,
        response_format: 'json',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/content-safety settings/);
    });

    it('returns error when approvals exist but none are approved/edited', async () => {
      const planId = '22222222-2222-2222-2222-222222222222';

      mockPlanEdgeCalls(
        {
          data: {
            success: true,
            plan: {
              id: planId,
              plan_payload: {
                posts: [
                  {
                    id: 'day1-twitter-1',
                    caption: 'Pending post',
                    platform: 'twitter',
                    schedule_at: '2026-03-20T10:00:00Z',
                  },
                ],
              },
            },
          },
          error: null,
        },
        {
          data: {
            success: true,
            items: [{ post_id: 'day1-twitter-1', status: 'pending', edited_post: null }],
          },
          error: null,
        }
      );

      const handler = server.getHandler('schedule_content_plan')!;
      const result = await handler({
        plan_id: planId,
        auto_slot: false,
        dry_run: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('none are approved/edited');
      // Verify schedule-post was NOT called
      const schedulePostCalls = mockCallEdge.mock.calls.filter(c => c[0] === 'schedule-post');
      expect(schedulePostCalls).toHaveLength(0);
    });

    it('schedules with plan_id input without crashing', async () => {
      const planId = '55555555-5555-5555-5555-555555555555';

      mockPlanEdgeCalls({
        data: {
          success: true,
          plan: {
            id: planId,
            project_id: '11111111-1111-1111-1111-111111111111',
            plan_payload: {
              posts: [
                {
                  id: 'day1-twitter-1',
                  caption: 'High quality caption with clear CTA for audience growth.',
                  platform: 'twitter',
                  schedule_at: '2026-03-20T10:00:00Z',
                },
              ],
            },
          },
        },
        error: null,
      });

      const handler = server.getHandler('schedule_content_plan')!;
      const result = await handler({
        plan_id: planId,
        auto_slot: false,
        dry_run: false,
        enforce_quality: false,
        response_format: 'json',
      });

      expect(result.isError).toBe(false);
      const envelope = JSON.parse(result.content[0].text);
      expect(envelope.data.plan_id).toBe(planId);
      const schedulePostCall = mockCallEdge.mock.calls.find(call => call[0] === 'schedule-post');
      expect(schedulePostCall?.[1]).toEqual(
        expect.objectContaining({
          projectId: '11111111-1111-1111-1111-111111111111',
          project_id: '11111111-1111-1111-1111-111111111111',
          connectedAccountIds: { Twitter: 'twitter-account-1' },
        })
      );
    });
  });
});
