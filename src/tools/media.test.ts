import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerMediaTools } from './media.js';
import { callEdgeFunction } from '../lib/edge-function.js';

// Stub SSRF so upload_media URL-mode tests don't hit real DNS for fictional hosts.
vi.mock('../lib/ssrf.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/ssrf.js')>('../lib/ssrf.js');
  return {
    ...actual,
    validateUrlForSSRF: vi.fn(async (url: string) => {
      try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') {
          return { isValid: false, error: `Invalid protocol: ${u.protocol}` };
        }
        if (u.username || u.password) {
          return { isValid: false, error: 'URL contains credentials' };
        }
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

    // -----------------------------------------------------------------------
    // file_data / base64 path (remote-agent upload)
    // -----------------------------------------------------------------------
    describe('file_data (base64) path', () => {
      // 1x1 PNG
      const TINY_PNG_B64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';

      it('uploads raw base64 + content_type and returns r2_key', async () => {
        mockCallEdge.mockResolvedValueOnce({
          data: {
            success: true,
            url: 'https://signed.example.com/tiny.png',
            key: 'org_1/user_1/images/2026-04-21/tiny.png',
            size: 70,
            contentType: 'image/png',
          },
          error: null,
        });

        const handler = server.getHandler('upload_media')!;
        const result = await handler({
          file_data: TINY_PNG_B64,
          file_name: 'tiny.png',
          content_type: 'image/png',
        });

        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toContain('Media uploaded successfully');

        expect(mockCallEdge).toHaveBeenCalledWith(
          'upload-to-r2',
          expect.objectContaining({
            contentType: 'image/png',
            fileName: 'tiny.png',
            fileData: expect.stringMatching(/^data:image\/png;base64,/),
          }),
          expect.objectContaining({ timeoutMs: 60_000 })
        );
      });

      it('auto-extracts content_type from a data: URI prefix', async () => {
        mockCallEdge.mockResolvedValueOnce({
          data: {
            success: true,
            url: 'https://signed.example.com/x.jpg',
            key: 'org_1/user_1/images/2026-04-21/x.jpg',
            size: 100,
            contentType: 'image/jpeg',
          },
          error: null,
        });

        const handler = server.getHandler('upload_media')!;
        const result = await handler({
          file_data: `data:image/jpeg;base64,${TINY_PNG_B64}`,
          file_name: 'x.jpg',
        });

        expect(result.isError).toBeFalsy();
        expect(mockCallEdge).toHaveBeenCalledWith(
          'upload-to-r2',
          expect.objectContaining({ contentType: 'image/jpeg' }),
          expect.any(Object)
        );
      });

      it('rejects when content_type is missing and there is no data: prefix', async () => {
        const handler = server.getHandler('upload_media')!;
        const result = await handler({ file_data: TINY_PNG_B64, file_name: 'mystery.bin' });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('content_type is required');
        expect(mockCallEdge).not.toHaveBeenCalled();
      });

      it('rejects content_type not in the upload allowlist', async () => {
        const handler = server.getHandler('upload_media')!;
        const result = await handler({
          file_data: TINY_PNG_B64,
          content_type: 'application/x-msdownload',
          file_name: 'evil.exe',
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('not supported');
        expect(mockCallEdge).not.toHaveBeenCalled();
      });

      it('rejects oversized base64 (>10MB decoded) before calling the EF', async () => {
        // ~11MB of base64 'A' chars decodes to ~8.25MB of bytes? let's use enough to exceed 10MB.
        // MAX_BASE64_SIZE = 10MB decoded -> base64 length >= 10MB * 4/3 ≈ 13.34MB of chars.
        const oversize = 'A'.repeat(14 * 1024 * 1024);

        const handler = server.getHandler('upload_media')!;
        const result = await handler({
          file_data: oversize,
          content_type: 'image/png',
          file_name: 'huge.png',
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('10MB');
        expect(result.content[0].text).toContain('presigned PUT');
        expect(mockCallEdge).not.toHaveBeenCalled();
      });

      it('rejects invalid base64 characters', async () => {
        const handler = server.getHandler('upload_media')!;
        const result = await handler({
          file_data: 'not*valid*base64!!!',
          content_type: 'image/png',
          file_name: 'bad.png',
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('not valid base64');
        expect(mockCallEdge).not.toHaveBeenCalled();
      });

      it('basename-sanitizes file_name to prevent path traversal', async () => {
        mockCallEdge.mockResolvedValueOnce({
          data: {
            success: true,
            url: 'https://signed.example.com/evil.png',
            key: 'org_1/user_1/images/2026-04-21/evil.png',
            size: 70,
            contentType: 'image/png',
          },
          error: null,
        });

        const handler = server.getHandler('upload_media')!;
        await handler({
          file_data: TINY_PNG_B64,
          content_type: 'image/png',
          file_name: '../../../etc/passwd/evil.png',
        });

        expect(mockCallEdge).toHaveBeenCalledWith(
          'upload-to-r2',
          expect.objectContaining({ fileName: 'evil.png' }),
          expect.any(Object)
        );
      });

      it('blocks local file paths in HTTP transport mode and directs to file_data', async () => {
        // HTTP transport set by mcp-server/src/http.ts at boot; vitest defaults to
        // unset (effectively non-stdio), so the default-deny branch trips.
        const prior = process.env.MCP_TRANSPORT;
        delete process.env.MCP_TRANSPORT;
        try {
          const handler = server.getHandler('upload_media')!;
          const result = await handler({ source: '/definitely/not/a/real/path.png' });
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain('not accepted on the cloud MCP server');
          expect(result.content[0].text).toContain('file_data');
        } finally {
          if (prior !== undefined) process.env.MCP_TRANSPORT = prior;
        }
      });

      it('falls back to the readable "File not found" error in stdio transport', async () => {
        const prior = process.env.MCP_TRANSPORT;
        process.env.MCP_TRANSPORT = 'stdio';
        try {
          const handler = server.getHandler('upload_media')!;
          const result = await handler({ source: '/definitely/not/a/real/path.png' });
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain('File not found');
          expect(result.content[0].text).toContain('file_data');
        } finally {
          if (prior === undefined) delete process.env.MCP_TRANSPORT;
          else process.env.MCP_TRANSPORT = prior;
        }
      });

      it('errors when neither source nor file_data is provided', async () => {
        const handler = server.getHandler('upload_media')!;
        const result = await handler({});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('source');
        expect(result.content[0].text).toContain('file_data');
        expect(mockCallEdge).not.toHaveBeenCalled();
      });
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
        expect.objectContaining({ r2Key: 'org_1/user_1/img.png', operation: 'get' }),
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

    it('accepts the r2:// key returned by check_status', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { signedUrl: 'https://signed.example.com/video.mp4', expiresIn: 3600 },
        error: null,
      });

      const handler = server.getHandler('get_media_url')!;
      const result = await handler({
        r2_key: 'r2://org_1/user_1/project_1/videos/generated.mp4',
        response_format: 'json',
      });

      expect(result.isError).toBeFalsy();
      expect(mockCallEdge).toHaveBeenCalledWith(
        'get-signed-url',
        { r2Key: 'org_1/user_1/project_1/videos/generated.mp4', operation: 'get' },
        { timeoutMs: 10_000 }
      );
      expect(JSON.parse(result.content[0].text).r2_key).toBe(
        'r2://org_1/user_1/project_1/videos/generated.mp4'
      );
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
