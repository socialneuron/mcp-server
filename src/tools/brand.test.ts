import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerBrandTools } from './brand.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getSupabaseClient, getDefaultUserId, getDefaultProjectId } from '../lib/supabase.js';

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetClient = vi.mocked(getSupabaseClient);
const mockGetUserId = vi.mocked(getDefaultUserId);
const mockGetProjectId = vi.mocked(getDefaultProjectId);

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
      expect(body).toEqual({ url: 'https://example.com' });
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
      expect(parsed._meta.version).toBe('0.2.0');
      expect(parsed.data.brandName).toBe('JsonBrand');
    });
  });

  describe('get_brand_profile', () => {
    it('loads active profile for accessible project', async () => {
      const projectChain = chainMock({
        data: { id: 'proj-1', organization_id: 'org-1' },
        error: null,
      });
      const memberChain = chainMock({ data: { organization_id: 'org-1' }, error: null });
      const profileChain = chainMock({
        data: { brand_name: 'Acme', version: 3, updated_at: '2026-02-15T00:00:00Z' },
        error: null,
      });

      const fromMock = vi.fn((table: string) => {
        if (table === 'projects') return projectChain;
        if (table === 'organization_members') return memberChain;
        if (table === 'brand_profiles') return profileChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock, rpc: vi.fn() } as any);

      const handler = server.getHandler('get_brand_profile')!;
      const result = await handler({});
      expect(result.content[0].text).toContain('Acme');
      expect(result.content[0].text).toContain('Version: 3');
    });
  });

  describe('save_brand_profile', () => {
    it('persists active profile via set_active_brand_profile rpc', async () => {
      const projectChain = chainMock({
        data: { id: 'proj-1', organization_id: 'org-1' },
        error: null,
      });
      const memberChain = chainMock({ data: { organization_id: 'org-1' }, error: null });
      const savedChain = chainMock({
        data: { id: 'profile-1', version: 4, updated_at: '2026-02-15T00:00:00Z' },
        error: null,
      });
      const rpcMock = vi.fn().mockResolvedValue({ data: 'profile-1', error: null });

      const fromMock = vi.fn((table: string) => {
        if (table === 'projects') return projectChain;
        if (table === 'organization_members') return memberChain;
        if (table === 'brand_profiles') return savedChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock, rpc: rpcMock } as any);

      const handler = server.getHandler('save_brand_profile')!;
      const result = await handler({
        brand_context: { name: 'Acme' },
        response_format: 'json',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.success).toBe(true);
      expect(rpcMock).toHaveBeenCalledWith('set_active_brand_profile', expect.any(Object));
    });
  });

  describe('update_platform_voice', () => {
    it('merges override and saves a new active profile version', async () => {
      const projectChain = chainMock({
        data: { id: 'proj-1', organization_id: 'org-1' },
        error: null,
      });
      const memberChain = chainMock({ data: { organization_id: 'org-1' }, error: null });
      const profileChain = chainMock({
        data: {
          brand_context: {
            name: 'Acme',
            voiceProfile: {
              tone: ['professional'],
              platformOverrides: {
                linkedin: { ctaStyle: 'question' },
              },
            },
          },
        },
        error: null,
      });
      const rpcMock = vi.fn().mockResolvedValue({ data: 'profile-2', error: null });

      const fromMock = vi.fn((table: string) => {
        if (table === 'projects') return projectChain;
        if (table === 'organization_members') return memberChain;
        if (table === 'brand_profiles') return profileChain;
        return chainMock();
      });
      mockGetClient.mockReturnValue({ from: fromMock, rpc: rpcMock } as any);

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
      expect(rpcMock).toHaveBeenCalledWith(
        'set_active_brand_profile',
        expect.objectContaining({
          p_changed_paths: ['voiceProfile.platformOverrides.linkedin'],
        })
      );
    });
  });
});
