import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerCommentsTools } from './comments.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('comments tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerCommentsTools(server as any);
  });

  // =========================================================================
  // list_comments
  // =========================================================================
  describe('list_comments', () => {
    it('truncates text to 120 chars and includes pagination token in output', async () => {
      const longText = 'A'.repeat(200);

      mockCallEdge.mockResolvedValueOnce({
        data: {
          comments: [
            {
              id: 'c1',
              videoId: 'v1',
              videoTitle: 'My Video',
              authorDisplayName: 'TestUser',
              authorProfileImageUrl: 'https://example.com/avatar.jpg',
              textDisplay: longText,
              textOriginal: longText,
              likeCount: 5,
              publishedAt: '2026-02-01T10:00:00Z',
              replyCount: 2,
            },
          ],
          nextPageToken: 'token-abc-123',
        },
        error: null,
      });

      const handler = server.getHandler('list_comments')!;
      const result = await handler({});

      const text = result.content[0].text;
      // Should truncate to 120 chars + "..."
      expect(text).toContain('A'.repeat(120) + '...');
      // Should NOT contain the full 200-char string
      expect(text).not.toContain('A'.repeat(121) + '"');
      // Should contain pagination token
      expect(text).toContain('Next page token: token-abc-123');
      // Should contain comment metadata
      expect(text).toContain('[c1]');
      expect(text).toContain('TestUser');
      expect(text).toContain('on "My Video"');
      expect(text).toContain('5 likes');
      expect(text).toContain('2 replies');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          comments: [
            {
              id: 'c1',
              videoId: 'v1',
              authorDisplayName: 'TestUser',
              authorProfileImageUrl: 'https://example.com/avatar.jpg',
              textDisplay: 'Hello',
              textOriginal: 'Hello',
              likeCount: 1,
              publishedAt: '2026-02-01T10:00:00Z',
              replyCount: 0,
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('list_comments')!;
      const result = await handler({ response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe('0.2.0');
      expect(parsed.data.comments.length).toBe(1);
    });
  });

  // =========================================================================
  // reply_to_comment
  // =========================================================================
  describe('reply_to_comment', () => {
    it('passes action reply with parentId and text to edge function', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          comment: { id: 'reply-1', textDisplay: 'Thanks for the feedback!' },
        },
        error: null,
      });

      const handler = server.getHandler('reply_to_comment')!;
      const result = await handler({
        parent_id: 'comment-parent-123',
        text: 'Thanks for the feedback!',
      });

      expect(mockCallEdge).toHaveBeenCalledOnce();
      const [fnName, body] = mockCallEdge.mock.calls[0];
      expect(fnName).toBe('youtube-comments');
      expect(body).toEqual({
        action: 'reply',
        parentId: 'comment-parent-123',
        text: 'Thanks for the feedback!',
      });

      const text = result.content[0].text;
      expect(text).toContain('Reply posted successfully');
      expect(text).toContain('reply-1');
      expect(text).toContain('Thanks for the feedback!');
    });
  });

  // =========================================================================
  // moderate_comment
  // =========================================================================
  describe('moderate_comment', () => {
    it('passes action moderate with commentId and moderationStatus to edge function', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: {}, error: null });

      const handler = server.getHandler('moderate_comment')!;
      const result = await handler({
        comment_id: 'spam-comment-456',
        moderation_status: 'rejected',
      });

      expect(mockCallEdge).toHaveBeenCalledOnce();
      const [fnName, body] = mockCallEdge.mock.calls[0];
      expect(fnName).toBe('youtube-comments');
      expect(body).toEqual({
        action: 'moderate',
        commentId: 'spam-comment-456',
        moderationStatus: 'rejected',
      });

      const text = result.content[0].text;
      expect(text).toContain('spam-comment-456');
      expect(text).toContain('rejected');
    });
  });

  // =========================================================================
  // delete_comment
  // =========================================================================
  describe('delete_comment', () => {
    it('returns success message with comment ID', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: {}, error: null });

      const handler = server.getHandler('delete_comment')!;
      const result = await handler({ comment_id: 'old-comment-789' });

      expect(mockCallEdge).toHaveBeenCalledOnce();
      const [fnName, body] = mockCallEdge.mock.calls[0];
      expect(fnName).toBe('youtube-comments');
      expect(body).toEqual({
        action: 'delete',
        commentId: 'old-comment-789',
      });

      const text = result.content[0].text;
      expect(text).toContain('old-comment-789');
      expect(text).toContain('deleted successfully');
    });
  });
});
