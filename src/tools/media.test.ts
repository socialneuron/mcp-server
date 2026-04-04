import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerMediaTools } from './media.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('media tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerMediaTools(server as any);
  });

  // =========================================================================
  // upload_media
  // =========================================================================
  describe('upload_media', () => {
    it('uploads an external URL to R2 and returns r2_key', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          url: 'https://r2-signed-url.example.com/image.png',
          key: 'org_1/user_1/images/2026-04-03/abc.png',
          size: 512000,
          contentType: 'image/png',
        },
        error: null,
      });

      const handler = server.getHandler('upload_media')!;
      const result = await handler({ source: 'https://example.com/photo.png' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Media uploaded successfully');
      expect(result.content[0].text).toContain('Media key: …/2026-04-03/abc.png');
      expect(mockCallEdge).toHaveBeenCalledWith(
        'upload-to-r2',
        expect.objectContaining({
          url: 'https://example.com/photo.png',
          contentType: 'image/png',
        }),
        expect.objectContaining({ timeoutMs: 60_000 })
      );
    });

    it('returns JSON format when requested', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          url: 'https://signed.example.com/img.jpg',
          key: 'org_1/user_1/images/2026-04-03/def.jpg',
          size: 256000,
          contentType: 'image/jpeg',
        },
        error: null,
      });

      const handler = server.getHandler('upload_media')!;
      const result = await handler({
        source: 'https://example.com/photo.jpg',
        response_format: 'json',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.r2_key).toBe('org_1/user_1/images/2026-04-03/def.jpg');
      expect(parsed.signed_url).toBe('https://signed.example.com/img.jpg');
      expect(parsed.size).toBe(256000);
    });

    it('returns error when upload fails', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Storage quota exceeded',
      });

      const handler = server.getHandler('upload_media')!;
      const result = await handler({ source: 'https://example.com/big-video.mp4' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Upload failed: Storage quota exceeded');
    });

    it('returns error when upload returns no key', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          url: 'https://signed.example.com',
          key: '',
          size: 0,
          contentType: '',
        },
        error: null,
      });

      const handler = server.getHandler('upload_media')!;
      const result = await handler({ source: 'https://example.com/photo.png' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no R2 key');
    });

    it('infers content type from file extension', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          url: 'https://signed.example.com/vid.mp4',
          key: 'org_1/user_1/videos/2026-04-03/vid.mp4',
          size: 5000000,
          contentType: 'video/mp4',
        },
        error: null,
      });

      const handler = server.getHandler('upload_media')!;
      await handler({ source: 'https://cdn.example.com/video.mp4' });
      expect(mockCallEdge).toHaveBeenCalledWith(
        'upload-to-r2',
        expect.objectContaining({ contentType: 'video/mp4' }),
        expect.any(Object)
      );
    });

    it('passes project_id to upload-to-r2', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          url: 'https://s.com/x',
          key: 'k',
          size: 100,
          contentType: 'image/png',
        },
        error: null,
      });

      const handler = server.getHandler('upload_media')!;
      await handler({ source: 'https://example.com/img.png', project_id: 'proj-123' });
      expect(mockCallEdge).toHaveBeenCalledWith(
        'upload-to-r2',
        expect.objectContaining({ projectId: 'proj-123' }),
        expect.any(Object)
      );
    });
  });

  // =========================================================================
  // get_media_url
  // =========================================================================
  describe('get_media_url', () => {
    it('signs an R2 key and returns the URL', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          signedUrl: 'https://r2-fresh-signed.example.com/img.png',
          key: 'org_1/user_1/img.png',
          expiresIn: 3600,
        },
        error: null,
      });

      const handler = server.getHandler('get_media_url')!;
      const result = await handler({ r2_key: 'org_1/user_1/img.png' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain(
        'Signed URL: https://r2-fresh-signed.example.com/img.png'
      );
      expect(result.content[0].text).toContain('Expires in: 3600s');
      expect(mockCallEdge).toHaveBeenCalledWith(
        'get-signed-url',
        expect.objectContaining({ key: 'org_1/user_1/img.png', operation: 'get' }),
        expect.objectContaining({ timeoutMs: 10_000 })
      );
    });

    it('returns JSON format when requested', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { signedUrl: 'https://signed.example.com/x', key: 'k', expiresIn: 3600 },
        error: null,
      });

      const handler = server.getHandler('get_media_url')!;
      const result = await handler({ r2_key: 'some/key', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.signed_url).toBe('https://signed.example.com/x');
      expect(parsed.r2_key).toBe('some/key');
      expect(parsed.expires_in).toBe(3600);
    });

    it('returns error when signing fails', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Key not found',
      });

      const handler = server.getHandler('get_media_url')!;
      const result = await handler({ r2_key: 'nonexistent/key' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to sign R2 key');
    });

    it('defaults expires_in to 3600 when not in response', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { signedUrl: 'https://signed.example.com/x', key: 'k' },
        error: null,
      });

      const handler = server.getHandler('get_media_url')!;
      const result = await handler({ r2_key: 'some/key', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.expires_in).toBe(3600);
    });

    it('returns error when no signed URL in response', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { signedUrl: '', key: 'k', expiresIn: 0 },
        error: null,
      });

      const handler = server.getHandler('get_media_url')!;
      const result = await handler({ r2_key: 'some/key' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No signed URL returned');
    });
  });
});
