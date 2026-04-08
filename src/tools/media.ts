import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { callEdgeFunction } from '../lib/edge-function.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getDefaultUserId, logMcpToolInvocation } from '../lib/supabase.js';

/** Max base64 upload size (10MB) — larger files need presigned PUT */
const MAX_BASE64_SIZE = 10 * 1024 * 1024;

/** Mask R2 key for display — hides org/user IDs, shows only filename */
function maskR2Key(key: string): string {
  const segments = key.split('/');
  return segments.length >= 3 ? `…/${segments.slice(-2).join('/')}` : key;
}

/** Infer content type from file extension */
function inferContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.webm': 'video/webm',
    '.svg': 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

export function registerMediaTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // upload_media — Upload local file or external URL to R2
  // ---------------------------------------------------------------------------
  server.tool(
    'upload_media',
    'Upload a local file or external URL to persistent R2 storage. Returns a durable r2_key ' +
      'that can be passed to schedule_post. Use for images, videos, or any media that needs to be ' +
      'posted to social platforms. Accepts local file paths (in MCP stdio mode) or public URLs. ' +
      'Max 10MB for base64 upload — larger files return an error with guidance.',
    {
      source: z
        .string()
        .describe(
          'Local file path (e.g. "/Users/me/image.png") or public URL (e.g. "https://example.com/photo.jpg"). ' +
            'Local files are read and uploaded as base64. URLs are fetched by the server.'
        ),
      content_type: z
        .string()
        .optional()
        .describe(
          'MIME type (e.g. "image/png", "video/mp4"). Auto-detected from file extension if omitted.'
        ),
      project_id: z.string().optional().describe('Project ID for R2 path organization.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Default: text.'),
    },
    async ({ source, content_type, project_id, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();
      const userId = await getDefaultUserId();

      const rateLimit = checkRateLimit('upload', `upload_media:${userId}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'upload_media',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const isUrl = source.startsWith('http://') || source.startsWith('https://');
      const isLocalFile = !isUrl;

      let uploadBody: Record<string, unknown>;

      if (isUrl) {
        // External URL — pass to upload-to-r2 EF which fetches it
        const ct = content_type || inferContentType(source);
        uploadBody = {
          url: source,
          contentType: ct,
          fileName: basename(new URL(source).pathname) || 'upload',
          projectId: project_id,
        };
      } else {
        // Local file — read, check size, base64 encode
        let fileBuffer: Buffer;
        try {
          fileBuffer = await readFile(source);
        } catch (err) {
          await logMcpToolInvocation({
            toolName: 'upload_media',
            status: 'error',
            durationMs: Date.now() - startedAt,
            details: { error: `File not found: ${source}` },
          });
          return {
            content: [
              {
                type: 'text' as const,
                text: `File not found or not readable: ${source}`,
              },
            ],
            isError: true,
          };
        }

        const ct = content_type || inferContentType(source);

        if (fileBuffer.length > MAX_BASE64_SIZE) {
          // Large file — use presigned PUT upload (up to ~500MB)
          const { data: putData, error: putError } = await callEdgeFunction<{
            signedUrl: string;
            key: string;
            expiresIn: number;
          }>(
            'get-signed-url',
            {
              operation: 'put',
              contentType: ct,
              filename: basename(source),
              projectId: project_id,
            },
            { timeoutMs: 10_000 }
          );

          if (putError || !putData?.signedUrl) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Failed to get presigned upload URL: ${putError || 'No URL returned'}`,
                },
              ],
              isError: true,
            };
          }

          // Upload directly to R2 via presigned PUT
          try {
            const putResp = await fetch(putData.signedUrl, {
              method: 'PUT',
              headers: { 'Content-Type': ct },
              body: fileBuffer,
            });

            if (!putResp.ok) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `R2 upload failed (HTTP ${putResp.status}): ${await putResp.text().catch(() => 'Unknown error')}`,
                  },
                ],
                isError: true,
              };
            }
          } catch (uploadErr) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `R2 upload failed: ${sanitizeError(uploadErr)}`,
                },
              ],
              isError: true,
            };
          }

          // Presigned PUT succeeded — return the R2 key directly
          const { data: signData } = await callEdgeFunction<{ signedUrl: string }>(
            'get-signed-url',
            { key: putData.key, operation: 'get' },
            { timeoutMs: 10_000 }
          );

          await logMcpToolInvocation({
            toolName: 'upload_media',
            status: 'success',
            durationMs: Date.now() - startedAt,
            details: {
              source: 'local-presigned-put',
              r2Key: putData.key,
              size: fileBuffer.length,
              contentType: ct,
            },
          });

          if (format === 'json') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      r2_key: putData.key,
                      signed_url: signData?.signedUrl ?? null,
                      size: fileBuffer.length,
                      content_type: ct,
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: false,
            };
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: [
                  'Media uploaded successfully (presigned PUT).',
                  `Media key: ${maskR2Key(putData.key)}`,
                  signData?.signedUrl ? `Signed URL: ${signData.signedUrl}` : '',
                  `Size: ${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB`,
                  `Type: ${ct}`,
                  '',
                  'Use job_id or response_format=json with schedule_post to post to any platform.',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            isError: false,
          };
        }

        const base64 = `data:${ct};base64,${fileBuffer.toString('base64')}`;
        uploadBody = {
          fileData: base64,
          contentType: ct,
          fileName: basename(source),
          projectId: project_id,
        };
      }

      const { data, error } = await callEdgeFunction<{
        success: boolean;
        url: string;
        key: string;
        size: number;
        contentType: string;
      }>('upload-to-r2', uploadBody, { timeoutMs: 60_000 });

      if (error) {
        await logMcpToolInvocation({
          toolName: 'upload_media',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error, source: isUrl ? 'url' : 'local' },
        });
        return {
          content: [{ type: 'text' as const, text: `Upload failed: ${error}` }],
          isError: true,
        };
      }

      if (!data?.key) {
        return {
          content: [{ type: 'text' as const, text: 'Upload returned no R2 key.' }],
          isError: true,
        };
      }

      await logMcpToolInvocation({
        toolName: 'upload_media',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: {
          source: isUrl ? 'url' : 'local',
          r2Key: data.key,
          size: data.size,
          contentType: data.contentType,
        },
      });

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  r2_key: data.key,
                  signed_url: data.url,
                  size: data.size,
                  content_type: data.contentType,
                },
                null,
                2
              ),
            },
          ],
          isError: false,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              'Media uploaded successfully.',
              `Media key: ${maskR2Key(data.key)}`,
              `Signed URL: ${data.url}`,
              `Size: ${(data.size / 1024).toFixed(0)}KB`,
              `Type: ${data.contentType}`,
              '',
              'Use job_id or response_format=json with schedule_post to post to any platform.',
            ].join('\n'),
          },
        ],
        isError: false,
      };
    }
  );

  // ---------------------------------------------------------------------------
  // get_media_url — Sign an R2 key on demand
  // ---------------------------------------------------------------------------
  server.tool(
    'get_media_url',
    'Get a fresh signed URL for an R2 media key. Use when a previously returned signed URL has ' +
      'expired (they last 1 hour). Pass the r2_key from upload_media or check_status.',
    {
      r2_key: z
        .string()
        .describe('The R2 object key (e.g. "org_x/user_y/images/2026-04-03/abc.png").'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Default: text.'),
    },
    async ({ r2_key, response_format }) => {
      const format = response_format ?? 'text';
      const startedAt = Date.now();

      const { data, error } = await callEdgeFunction<{
        signedUrl: string;
        key: string;
        expiresIn: number;
      }>('get-signed-url', { key: r2_key, operation: 'get' }, { timeoutMs: 10_000 });

      if (error) {
        await logMcpToolInvocation({
          toolName: 'get_media_url',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error, r2Key: r2_key },
        });
        return {
          content: [{ type: 'text' as const, text: `Failed to sign R2 key: ${error}` }],
          isError: true,
        };
      }

      if (!data?.signedUrl) {
        return {
          content: [{ type: 'text' as const, text: 'No signed URL returned.' }],
          isError: true,
        };
      }

      await logMcpToolInvocation({
        toolName: 'get_media_url',
        status: 'success',
        durationMs: Date.now() - startedAt,
        details: { r2Key: r2_key },
      });

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { signed_url: data.signedUrl, r2_key, expires_in: data.expiresIn ?? 3600 },
                null,
                2
              ),
            },
          ],
          isError: false,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Signed URL: ${data.signedUrl}`,
              `Media key: ${maskR2Key(r2_key)}`,
              `Expires in: ${data.expiresIn ?? 3600}s`,
            ].join('\n'),
          },
        ],
        isError: false,
      };
    }
  );
}
