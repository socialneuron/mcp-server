import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { callEdgeFunction } from '../lib/edge-function.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { sanitizeError } from '../lib/sanitize-error.js';
import { getDefaultUserId, logMcpToolInvocation } from '../lib/supabase.js';

/** Max base64 upload size (10MB decoded) — larger files need presigned PUT. */
const MAX_BASE64_SIZE = 10 * 1024 * 1024;

/** Mirrors the allowlist enforced by supabase/functions/upload-to-r2. */
const ALLOWED_UPLOAD_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
]);

const BASE64_CHARS = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URI_PREFIX = /^data:([^;,]+);base64,/;

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

/** Approximate decoded size of a base64 string without allocating a Buffer. */
function approxBase64Size(raw: string): number {
  const len = raw.length;
  if (len === 0) return 0;
  let padding = 0;
  if (raw.endsWith('==')) padding = 2;
  else if (raw.endsWith('=')) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

export function registerMediaTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // upload_media — Upload local file, external URL, or inline base64 to R2
  // ---------------------------------------------------------------------------
  server.tool(
    'upload_media',
    'Upload media to persistent R2 storage. Returns a durable r2_key that can be passed to ' +
      'schedule_post. Three input modes: (1) local file path (stdio mode only), (2) public URL ' +
      'fetched by the server, (3) inline base64 via file_data — use this from Claude Desktop, ' +
      'Claude Web, or any remote agent that cannot hand the server a filesystem path. Base64 ' +
      'uploads are capped at 10MB decoded; larger files still need stdio + presigned PUT.',
    {
      source: z
        .string()
        .optional()
        .describe(
          'Local file path (e.g. "/Users/me/image.png") or public URL (e.g. "https://example.com/photo.jpg"). ' +
            'Leave empty when passing file_data instead.'
        ),
      file_data: z
        .string()
        .optional()
        .describe(
          'Base64-encoded file bytes, with or without a "data:<mime>;base64," prefix. Use this ' +
            'from remote agents (Claude Web/Desktop) that cannot provide a filesystem path. ' +
            'Max 10MB decoded.'
        ),
      file_name: z
        .string()
        .optional()
        .describe(
          'Optional filename for the upload (e.g. "hero.png"). Path components are stripped — ' +
            'only the basename is used.'
        ),
      content_type: z
        .string()
        .optional()
        .describe(
          'MIME type (e.g. "image/png", "video/mp4"). Auto-detected from file extension for ' +
            'paths/URLs, or from the data: prefix on file_data. Required when passing raw ' +
            'base64 with no prefix.'
        ),
      project_id: z.string().optional().describe('Project ID for R2 path organization.'),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Default: text.'),
    },
    async ({ source, file_data, file_name, content_type, project_id, response_format }) => {
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

      if (!source && !file_data) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'upload_media requires either `source` (path or URL) or `file_data` (base64).',
            },
          ],
          isError: true,
        };
      }

      // ---------------------------------------------------------------------
      // Inline base64 mode (remote-agent friendly)
      // ---------------------------------------------------------------------
      if (file_data) {
        let raw = file_data;
        let detectedType: string | undefined;
        const prefixMatch = raw.match(DATA_URI_PREFIX);
        if (prefixMatch) {
          detectedType = prefixMatch[1].trim().toLowerCase();
          raw = raw.slice(prefixMatch[0].length);
        }

        const ct = (content_type ?? detectedType ?? '').trim().toLowerCase();
        if (!ct) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'content_type is required when file_data has no data: prefix.',
              },
            ],
            isError: true,
          };
        }

        if (!ALLOWED_UPLOAD_TYPES.has(ct)) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `content_type "${ct}" is not supported. Allowed: ` +
                  `${[...ALLOWED_UPLOAD_TYPES].sort().join(', ')}.`,
              },
            ],
            isError: true,
          };
        }

        const stripped = raw.replace(/\s+/g, '');
        if (!BASE64_CHARS.test(stripped)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'file_data is not valid base64 — only A-Z, a-z, 0-9, +, /, = are allowed.',
              },
            ],
            isError: true,
          };
        }

        const approxSize = approxBase64Size(stripped);
        if (approxSize > MAX_BASE64_SIZE) {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `file_data exceeds the 10MB base64 cap (got ~${(approxSize / 1024 / 1024).toFixed(1)}MB). ` +
                  `For larger files, run the stdio MCP server locally and pass a file path so the ` +
                  `server can use presigned PUT upload.`,
              },
            ],
            isError: true,
          };
        }

        const safeName = basename(file_name ?? 'upload');

        const uploadBody: Record<string, unknown> = {
          fileData: `data:${ct};base64,${stripped}`,
          contentType: ct,
          fileName: safeName,
          projectId: project_id,
        };

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
            details: { error, source: 'base64', contentType: ct, size: approxSize },
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
            source: 'base64',
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

      // At this point `source` is guaranteed present (we errored above otherwise).
      const src = source as string;
      const isUrl = src.startsWith('http://') || src.startsWith('https://');

      let uploadBody: Record<string, unknown>;

      if (isUrl) {
        // External URL — pass to upload-to-r2 EF which fetches it
        const ct = content_type || inferContentType(src);
        uploadBody = {
          url: src,
          contentType: ct,
          fileName: basename(file_name ?? new URL(src).pathname) || 'upload',
          projectId: project_id,
        };
      } else {
        // Local file — read, check size, base64 encode
        let fileBuffer: Buffer;
        try {
          fileBuffer = await readFile(src);
        } catch {
          await logMcpToolInvocation({
            toolName: 'upload_media',
            status: 'error',
            durationMs: Date.now() - startedAt,
            details: { error: 'File not found', source: 'local' },
          });
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `File not found or not readable: ${src}. ` +
                  `Remote agents (Claude Web/Desktop) cannot see the MCP server's filesystem — ` +
                  `pass the bytes via the \`file_data\` parameter (base64, up to 10MB) instead.`,
              },
            ],
            isError: true,
          };
        }

        const ct = content_type || inferContentType(src);

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
              filename: basename(file_name ?? src),
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
          fileName: basename(file_name ?? src),
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
