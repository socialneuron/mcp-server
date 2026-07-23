import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { callEdgeFunction } from '../lib/edge-function.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { sanitizeError } from '../lib/sanitize-error.js';
import { validateUrlForSSRF } from '../lib/ssrf.js';
import { getDefaultUserId } from '../lib/supabase.js';

/** Max base64 upload size (10MB decoded) — larger files need presigned PUT. */
const MAX_BASE64_SIZE = 10 * 1024 * 1024;

/**
 * Mirrors the ALLOWED_TYPES allowlist in supabase/functions/upload-to-r2/index.ts.
 * Keep in sync — drift causes either wasted round-trips (client allows, EF rejects)
 * or silent feature gaps (client blocks, EF would have accepted). URL-safe base64
 * (`-`/`_`) is deliberately excluded to match the EF's `atob`-compatible decoding.
 */
const ALLOWED_UPLOAD_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
]);

const BASE64_CHARS = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URI_PREFIX = /^data:([^;,]+);base64,/;

/** Mask R2 key for display — hides org/user IDs, shows only filename */
function maskR2Key(key: string): string {
  const segments = key.split('/');
  return segments.length >= 3 ? `…/${segments.slice(-2).join('/')}` : key;
}

/** Infer content type from file extension. Restricted to extensions whose
 *  MIME type is in ALLOWED_UPLOAD_TYPES — keeps inferred types in sync with
 *  what the upload-to-r2 EF actually accepts. */
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
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
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
      'fetched by the server, (3) inline base64 via file_data (remote agents, ≤10MB decoded). ' +
      'AGENT ROUTING GUIDE: If the media was produced by another tool here (generate_image, ' +
      'generate_video, create_carousel, etc.), use the returned job_id or r2_key directly with ' +
      'schedule_post — do NOT download and re-upload. For user-authored files larger than ~1MB, ' +
      'prefer request_upload_session (returns a tokenized Dashboard URL the user uploads through ' +
      'in their browser) so bytes never flow through the agent context. Reserve file_data for ' +
      'small assets (thumbnails, logos, short clips).',
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
      const userId = await getDefaultUserId();

      const rateLimit = checkRateLimit('upload', `upload_media:${userId}`);
      if (!rateLimit.allowed) {
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
                  `Alternatives, in order of preference: ` +
                  `(1) if this media came from another tool here (generate_image/video, create_carousel), ` +
                  `pass its job_id or r2_key directly to schedule_post — do not re-upload. ` +
                  `(2) for user-authored files, call request_upload_session to get a tokenized Dashboard ` +
                  `URL where the user uploads directly to R2 in their browser. ` +
                  `(3) for stdio/local mode, pass a filesystem path via \`source\` so the server can ` +
                  `stream and use presigned PUT.`,
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
        // External URL — defence-in-depth SSRF check before round-tripping
        // to the EF. The upload-to-r2 EF re-validates server-side, but
        // failing fast here saves a network call and avoids burning a
        // rate-limit token against the EF on obviously-bad URLs.
        const ssrf = await validateUrlForSSRF(src);
        if (!ssrf.isValid) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Source URL rejected by SSRF check: ${ssrf.error ?? 'invalid URL'}`,
              },
            ],
            isError: true,
          };
        }
        const safeSrc = ssrf.sanitizedUrl ?? src;
        const ct = content_type || inferContentType(safeSrc);
        uploadBody = {
          url: safeSrc,
          contentType: ct,
          fileName: basename(file_name ?? new URL(safeSrc).pathname) || 'upload',
          projectId: project_id,
        };
      } else {
        // Local file — read, check size, base64 encode.
        //
        // SECURITY: Only allowed when transport === 'stdio' (the agent runs on
        // the user's machine; reading their own filesystem is intended). On
        // the cloud HTTP server (Railway) `readFile(src)` would read process
        // secrets (`/proc/self/environ`, mounted k8s SA tokens, the very
        // SUPABASE_SERVICE_ROLE_KEY this process runs with), so default-deny.
        if (process.env.MCP_TRANSPORT !== 'stdio') {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Local file paths are not accepted on the cloud MCP server. ` +
                  `Pass the bytes via the \`file_data\` parameter (base64, up to 10MB) ` +
                  `or supply a public URL via \`source\`.`,
              },
            ],
            isError: true,
          };
        }
        let fileBuffer: Buffer;
        try {
          fileBuffer = await readFile(src);
        } catch {
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
            signedUrl?: string;
            url?: string;
            key: string;
            expiresIn?: number;
          }>(
            'get-signed-url',
            {
              operation: 'put',
              contentType: ct,
              filename: basename(file_name ?? src),
              fileSize: fileBuffer.length,
              projectId: project_id,
            },
            { timeoutMs: 10_000 }
          );

          const putUrl = putData?.url ?? putData?.signedUrl;
          if (putError || !putUrl || !putData?.key) {
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
            const putResp = await fetch(putUrl, {
              method: 'PUT',
              headers: { 'Content-Type': ct },
              // Uint8Array: Buffer no longer satisfies BodyInit under @types/node 26 fetch types
              body: new Uint8Array(fileBuffer),
            });

            if (!putResp.ok) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    // Presigned-store bodies may include provider request IDs,
                    // bucket names, or signed URL fragments. Status is enough
                    // for user recovery and safe diagnostics.
                    text: `R2 upload failed (HTTP ${putResp.status}). Please retry.`,
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
          const { data: signData } = await callEdgeFunction<{
            signedUrl?: string;
            url?: string;
          }>('get-signed-url', { r2Key: putData.key, operation: 'get' }, { timeoutMs: 10_000 });
          const signedDownloadUrl = signData?.url ?? signData?.signedUrl ?? null;

          if (format === 'json') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      r2_key: putData.key,
                      signed_url: signedDownloadUrl,
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
                  signedDownloadUrl ? `Signed URL: ${signedDownloadUrl}` : '',
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
    'Get a fresh signed URL for R2 media. Use when a previously returned signed URL has ' +
      'expired (they last 1 hour). Pass the r2_key from upload_media or check_status, or the ' +
      'job_id from check_status (the job row resolves the key server-side — works for legacy ' +
      'key formats too).',
    {
      r2_key: z
        .string()
        .optional()
        .describe('The R2 object key (e.g. "org_x/user_y/images/2026-04-03/abc.png").'),
      job_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'An async job ID from check_status. The server resolves the job to its stored media ' +
            'key — use this when the raw key fails to sign (legacy key formats).'
        ),
      response_format: z
        .enum(['text', 'json'])
        .optional()
        .describe('Response format. Default: text.'),
    },
    async ({ r2_key, job_id, response_format }) => {
      const format = response_format ?? 'text';
      // check_status returns durable storage references with an `r2://` marker
      // so callers can distinguish them from temporary provider URLs. The
      // signing Edge Function expects the raw object key, however. Accept the
      // exact value returned by check_status instead of forcing every agent to
      // know about and strip this transport marker itself.
      const normalizedR2Key = r2_key?.startsWith('r2://') ? r2_key.slice('r2://'.length) : r2_key;

      // 1f (2026-07-17 sweep): check_status tells agents they can pass its
      // job_id here — accept that handoff. A bare UUID is never a valid R2
      // object key (keys are paths), so treat it as a job id.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const effectiveJobId =
        job_id ?? (normalizedR2Key && UUID_RE.test(normalizedR2Key) ? normalizedR2Key : undefined);

      if (!effectiveJobId && !normalizedR2Key) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Provide r2_key or job_id (both come from upload_media / check_status).',
            },
          ],
          isError: true,
        };
      }

      const { data, error } = await callEdgeFunction<{
        signedUrl?: string;
        url?: string;
        key?: string;
        expiresIn?: number;
      }>(
        'get-signed-url',
        effectiveJobId
          ? { jobId: effectiveJobId, operation: 'get' }
          : { r2Key: normalizedR2Key, operation: 'get' },
        { timeoutMs: 10_000 }
      );

      const signedDownloadUrl = data?.url ?? data?.signedUrl;

      if (error) {
        // Legacy-format keys can fail path-based ownership validation even
        // though the media is the user's own — point the agent at the job_id
        // path, which resolves ownership through the job row instead.
        const legacyHint =
          /403|access denied|permission_denied|forbidden/i.test(error) && !effectiveJobId
            ? ' This media key may predate ownership tracking — retry with the job_id from check_status, or re-upload the file to get a canonical key.'
            : '';
        return {
          content: [
            { type: 'text' as const, text: `Failed to sign R2 key: ${error}${legacyHint}` },
          ],
          isError: true,
        };
      }

      if (!signedDownloadUrl) {
        return {
          content: [{ type: 'text' as const, text: 'No signed URL returned.' }],
          isError: true,
        };
      }

      if (format === 'json') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  signed_url: signedDownloadUrl,
                  r2_key: r2_key ?? data?.key ?? null,
                  ...(effectiveJobId ? { job_id: effectiveJobId } : {}),
                  expires_in: data?.expiresIn ?? 3600,
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
              `Signed URL: ${signedDownloadUrl}`,
              `Media key: ${maskR2Key(r2_key ?? data?.key ?? effectiveJobId ?? '')}`,
              `Expires in: ${data?.expiresIn ?? 3600}s`,
            ].join('\n'),
          },
        ],
        isError: false,
      };
    }
  );
}
