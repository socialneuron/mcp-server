import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerDistributionTools } from './distribution.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultUserId } from '../lib/supabase.js';

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetUserId = vi.mocked(getDefaultUserId);

describe('distribution tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerDistributionTools(server as any);
  });

  // =========================================================================
  // schedule_post
  // =========================================================================
  describe('schedule_post', () => {
    it('normalizes platform names to capitalized convention', async () => {
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

      expect(mockCallEdge).toHaveBeenCalledOnce();
      const callArgs = mockCallEdge.mock.calls[0];
      expect(callArgs[1].platforms).toEqual(['YouTube', 'TikTok']);
    });

    it('maps snake_case params to camelCase in edge function body', async () => {
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

      const body = mockCallEdge.mock.calls[0][1];
      expect(body).toEqual(
        expect.objectContaining({
          mediaUrl: 'https://cdn.example.com/img.png',
          caption: 'Hello world',
          platforms: ['Instagram'],
          title: 'My Post',
          hashtags: ['ai', 'social'],
          scheduledAt: '2026-03-15T14:00:00Z',
          projectId: 'proj-123',
        })
      );
    });

    it('returns formatted success text with platform results', async () => {
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

    it('returns JSON envelope when response_format=json', async () => {
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
      expect(parsed._meta.version).toBe('1.7.4');
      expect(parsed.data.success).toBe(true);
    });

    // =======================================================================
    // auto_rehost (URL → R2 persistence)
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
        expect(mockCallEdge).toHaveBeenNthCalledWith(
          2,
          'schedule-post',
          expect.objectContaining({
            mediaUrl:
              'https://r2-signed.example.com/org_1/user_1/rehosted.png?X-Amz-Signature=abc',
          }),
          expect.any(Object)
        );
      });

      it('skips rehost when the URL is already an R2 signed URL', async () => {
        mockCallEdge.mockResolvedValueOnce({
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
        expect(mockCallEdge).toHaveBeenCalledOnce();
        expect(mockCallEdge.mock.calls[0][0]).toBe('schedule-post');
      });

      it('skips rehost entirely when auto_rehost=false', async () => {
        mockCallEdge.mockResolvedValueOnce({
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

        expect(mockCallEdge).toHaveBeenCalledOnce();
        expect(mockCallEdge.mock.calls[0][0]).toBe('schedule-post');
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
        // 3 rehost calls, then 1 schedule-post
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
        expect(mockCallEdge).toHaveBeenCalledTimes(4);
        expect(mockCallEdge.mock.calls[0][0]).toBe('upload-to-r2');
        expect(mockCallEdge.mock.calls[3][0]).toBe('schedule-post');
        const schedBody = mockCallEdge.mock.calls[3][1] as { mediaUrls: string[] };
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
        expect(mockCallEdge).toHaveBeenCalledTimes(3);
        expect(mockCallEdge.mock.calls[0][0]).toBe('mcp-data'); // job-status lookup
        expect(mockCallEdge.mock.calls[1][0]).toBe('upload-to-r2'); // rehost
        expect(mockCallEdge.mock.calls[1][1]).toEqual(
          expect.objectContaining({ url: 'https://tempfile.kie.ai/abc/generated.mp4' })
        );
        expect(mockCallEdge.mock.calls[2][0]).toBe('schedule-post');
        expect(mockCallEdge.mock.calls[2][1]).toEqual(
          expect.objectContaining({
            mediaUrl: 'https://r2-signed.example.com/k.mp4?X-Amz-Signature=sig',
          })
        );
      });

      it('does not rehost a kie.ai job_id that already resolved to an R2 key', async () => {
        // R2 key path: mcp-data returns r2_key (no http prefix) → signR2Key →
        // already R2-signed → no rehost needed.
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
        // Exactly 3: job-status, sign, schedule-post — no upload-to-r2
        expect(mockCallEdge).toHaveBeenCalledTimes(3);
        expect(mockCallEdge.mock.calls.map(c => c[0])).toEqual([
          'mcp-data',
          'get-signed-url',
          'schedule-post',
        ]);
      });

      it('does not rehost when r2_key is already provided', async () => {
        // r2_key path: 1st call is sign (get-signed-url), 2nd is schedule-post
        mockCallEdge
          .mockResolvedValueOnce({
            data: { signedUrl: 'https://r2.example.com/k.png?X-Amz-Signature=sig' },
            error: null,
          })
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
        expect(mockCallEdge).toHaveBeenCalledTimes(2);
        expect(mockCallEdge.mock.calls[0][0]).toBe('get-signed-url');
        expect(mockCallEdge.mock.calls[1][0]).toBe('schedule-post');
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
              status: 'active',
              username: 'mychannel',
              created_at: '2026-01-15T10:00:00Z',
            },
            {
              id: 'a2',
              platform: 'TikTok',
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
        expect.objectContaining({ action: 'recent-posts', days: 14 })
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
    });
  });
});
