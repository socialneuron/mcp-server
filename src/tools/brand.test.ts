import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerBrandTools } from './brand.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getSupabaseClient, getDefaultUserId, getDefaultProjectId } from '../lib/supabase.js';
import { validateUrlForSSRF } from '../lib/ssrf.js';
import { MCP_VERSION } from '../lib/version.js';

vi.mock('../lib/ssrf.js', () => ({
  validateUrlForSSRF: vi
    .fn()
    .mockResolvedValue({ isValid: true, sanitizedUrl: 'https://example.com' }),
}));

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetClient = vi.mocked(getSupabaseClient);
const mockGetUserId = vi.mocked(getDefaultUserId);
const mockGetProjectId = vi.mocked(getDefaultProjectId);
const mockValidateSSRF = vi.mocked(validateUrlForSSRF);

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
    'rpc',
  ];
  for (const m of methods) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (resolve: (value: { data: any; error: any }) => unknown) => resolve(resolvedValue);
  c.catch = () => c;
  c.finally = () => c;
  return c;
}

describe('brand tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerBrandTools(server as any);
    mockGetUserId.mockResolvedValue('test-user-id');
    mockGetProjectId.mockResolvedValue('proj-1');
  });

  // =========================================================================
  // extract_brand
  // =========================================================================
  describe('extract_brand', () => {
    it('calls brand-extract with 60s timeout and returns formatted brand profile', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          brandName: 'TestBrand',
          description: 'A test brand',
          colors: { primary: '#000', secondary: '#fff', accent: '#f00' },
          voice: { tone: 'professional', style: 'clean', keywords: ['fast', 'reliable'] },
          audience: { primary: 'developers', painPoints: ['slow tools'] },
          logoUrl: 'https://example.com/logo.png',
        },
        error: null,
      });

      const handler = server.getHandler('extract_brand')!;
      const result = await handler({ url: 'https://example.com' });

      // Verify edge function call
      expect(mockCallEdge).toHaveBeenCalledOnce();
      const [fnName, body, opts] = mockCallEdge.mock.calls[0];
      expect(fnName).toBe('brand-extract');
      // Normalized via normalizeBrandUrlInput (2026-07-13 handle-input fix) —
      // a plain new URL(...).toString() round-trip adds the trailing slash.
      expect(body).toEqual({ url: 'https://example.com/' });
      expect(opts).toEqual({ timeoutMs: 60_000 });

      // Verify formatted output
      const text = result.content[0].text;
      expect(text).toContain('Brand Profile extracted from https://example.com');
      expect(text).toContain('Name: TestBrand');
      expect(text).toContain('Description: A test brand');
      expect(text).toContain('Primary: #000');
      expect(text).toContain('Secondary: #fff');
      expect(text).toContain('Accent: #f00');
      expect(text).toContain('Tone: professional');
      expect(text).toContain('Style: clean');
      expect(text).toContain('Keywords: fast, reliable');
      expect(text).toContain('Primary: developers');
      expect(text).toContain('Pain Points: slow tools');
      expect(text).toContain('Logo URL: https://example.com/logo.png');
    });

    it('returns isError on failure', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Failed to fetch URL: connection refused',
      });

      const handler = server.getHandler('extract_brand')!;
      const result = await handler({ url: 'https://down.example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Brand extraction failed');
      expect(result.content[0].text).toContain('Failed to fetch URL: connection refused');
    });

    it('returns JSON envelope when response_format=json', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          brandName: 'JsonBrand',
          description: 'JSON profile',
          colors: { primary: '#111', secondary: '#222', accent: '#333' },
          voice: { tone: 'direct', style: 'short', keywords: [] },
          audience: { primary: 'founders', painPoints: [] },
          logoUrl: null,
        },
        error: null,
      });

      const handler = server.getHandler('extract_brand')!;
      const result = await handler({ url: 'https://example.com', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBe(MCP_VERSION);
      expect(parsed.data.brandName).toBe('JsonBrand');
    });

    // 2026-07-13 fix: the `url` param used to be `z.string().url()`, which
    // forced the CALLING agent to guess a scheme onto a bare handle before
    // ever reaching us — the agent's guess (e.g. "https://littleworldloops")
    // then sailed through unvalidated to brand-extract, failing much later
    // with a raw DNS error. Both the bare-handle and the already-scheme'd
    // handle-shaped-hostname case must be rejected with actionable guidance,
    // never silently forwarded.
    it('rejects a bare handle with guidance instead of forwarding it to brand-extract', async () => {
      const handler = server.getHandler('extract_brand')!;
      const result = await handler({ url: 'littleworldloops' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('looks like a handle, not a full URL');
      expect(mockCallEdge).not.toHaveBeenCalled();
      expect(mockValidateSSRF).not.toHaveBeenCalled();
    });

    it('rejects a handle-shaped hostname even when the caller already guessed a scheme', async () => {
      const handler = server.getHandler('extract_brand')!;
      const result = await handler({ url: 'https://littleworldloops' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('looks like a handle, not a full URL');
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('rejects an ambiguous @handle with no platform', async () => {
      const handler = server.getHandler('extract_brand')!;
      const result = await handler({ url: '@littleworldloops' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('looks like a handle, not a full URL');
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('flags a scheme-only garbage string as an invalid URL', async () => {
      const handler = server.getHandler('extract_brand')!;
      const result = await handler({ url: 'https://' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not a valid URL');
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('resolves "platform:handle" shorthand to a canonical URL and proceeds with extraction', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          brandName: 'HandleBrand',
          description: 'resolved via platform prefix',
          colors: {},
          voice: {},
          audience: {},
          logoUrl: null,
        },
        error: null,
      });

      const handler = server.getHandler('extract_brand')!;
      const result = await handler({ url: 'instagram:littleworldloops' });

      expect(result.isError).toBeFalsy();
      const [, body] = mockCallEdge.mock.calls[0];
      expect(body).toEqual({ url: 'https://instagram.com/littleworldloops' });
    });
  });

  describe('get_brand_profile', () => {
    it('loads active profile via mcp-data EF', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          profile: {
            brand_name: 'Acme',
            version: 3,
            updated_at: '2026-02-15T00:00:00Z',
            extraction_method: 'manual',
            brand_context: {},
          },
        },
        error: null,
      });

      const handler = server.getHandler('get_brand_profile')!;
      const result = await handler({});
      expect(result.content[0].text).toContain('Acme');
      expect(result.content[0].text).toContain('Version: 3');
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ action: 'brand-profile' })
      );
    });

    it('delegates default project resolution to mcp-data when local project context is missing', async () => {
      mockGetProjectId.mockResolvedValueOnce(null);
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          profile: {
            project_id: 'resolved-project',
            brand_name: 'Resolved Brand',
            version: 1,
            updated_at: '2026-06-05T00:00:00Z',
            brand_context: {},
          },
        },
        error: null,
      });

      const handler = server.getHandler('get_brand_profile')!;
      const result = await handler({});

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain('Resolved Brand');
      expect(result.content[0].text).toContain('Project: resolved-project');
      expect(mockCallEdge).toHaveBeenCalledWith('mcp-data', { action: 'brand-profile' });
    });
  });

  describe('save_brand_profile', () => {
    it('persists active profile via mcp-data save-brand-profile action', async () => {
      // First call: save-brand-profile, second call: brand-profile (fetch saved)
      mockCallEdge
        .mockResolvedValueOnce({ data: { success: true, profileId: 'profile-1' }, error: null })
        .mockResolvedValueOnce({
          data: { success: true, profile: { version: 4, updated_at: '2026-02-15T00:00:00Z' } },
          error: null,
        });

      const handler = server.getHandler('save_brand_profile')!;
      const result = await handler({
        brand_context: { name: 'Acme' },
        response_format: 'json',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.success).toBe(true);
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ action: 'save-brand-profile' })
      );
    });
  });

  describe('update_platform_voice', () => {
    it('merges override and saves via mcp-data EF', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          profileId: 'profile-2',
          platform: 'linkedin',
          override: {
            sampleContent: 'Sample post one. Sample post two.',
            tone: ['credible', 'direct'],
            ctaStyle: 'question',
          },
        },
        error: null,
      });

      const handler = server.getHandler('update_platform_voice')!;
      const result = await handler({
        platform: 'linkedin',
        samples: 'Sample post one. Sample post two.',
        tone: ['credible', 'direct'],
        cta_style: 'question',
        response_format: 'json',
      });

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.success).toBe(true);
      expect(parsed.data.platform).toBe('linkedin');
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'update-platform-voice',
          platform: 'linkedin',
          samples: 'Sample post one. Sample post two.',
          tone: ['credible', 'direct'],
          cta_style: 'question',
        })
      );
    });
  });
});
