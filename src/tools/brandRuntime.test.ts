import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerBrandRuntimeTools } from './brandRuntime.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

/** Helper to build a brand profile response from mcp-data */
function brandProfileResponse(profile: Record<string, any> | null) {
  return {
    data: {
      success: true,
      profile: profile
        ? {
            profile_data: profile,
            extraction_metadata: profile._meta ?? {},
            default_style_ref_url: profile._styleRefUrl ?? null,
          }
        : null,
    },
    error: null,
  };
}

describe('brandRuntime tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerBrandRuntimeTools(server as any);
  });

  // =========================================================================
  // get_brand_runtime
  // =========================================================================
  describe('get_brand_runtime', () => {
    it('returns brand runtime from mcp-data EF', async () => {
      mockCallEdge.mockResolvedValueOnce(
        brandProfileResponse({
          name: 'TestBrand',
          industryClassification: 'SaaS',
          competitivePositioning: 'Best in class',
          valuePropositions: ['Fast', 'Reliable'],
          messagingPillars: ['Innovation'],
          contentPillars: [{ name: 'Tech', weight: 0.6 }],
          voiceProfile: { tone: ['professional'], style: ['concise'], avoidPatterns: ['slang'] },
          vocabularyRules: { preferredTerms: ['platform'], bannedTerms: ['tool'] },
          colorPalette: { primary: '#0066FF' },
          targetAudience: { demographics: { ageRange: '25-45' } },
          _meta: { overallConfidence: 0.85, scrapingProvider: 'firecrawl', pagesScraped: 12 },
          _styleRefUrl: 'https://example.com/ref.png',
        })
      );

      const handler = server.getHandler('get_brand_runtime')!;
      const result = await handler({});

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ action: 'brand-profile' })
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.name).toBe('TestBrand');
      expect(parsed.data.messaging.valuePropositions).toContain('Fast');
      expect(parsed.data.voice.bannedTerms).toContain('tool');
      expect(parsed.data.confidence.overall).toBe(0.85);
    });

    it('returns error when EF fails', async () => {
      mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Network error' });

      const handler = server.getHandler('get_brand_runtime')!;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network error');
    });

    it('returns message when no brand profile exists', async () => {
      mockCallEdge.mockResolvedValueOnce(brandProfileResponse(null));

      const handler = server.getHandler('get_brand_runtime')!;
      const result = await handler({});

      expect(result.content[0].text).toContain('No brand profile found');
      expect(result.content[0].text).toContain('extract_brand');
    });
  });

  // =========================================================================
  // explain_brand_system
  // =========================================================================
  describe('explain_brand_system', () => {
    it('returns completeness report from mcp-data EF', async () => {
      mockCallEdge.mockResolvedValueOnce(
        brandProfileResponse({
          name: 'TestBrand',
          tagline: 'Build better',
          industryClassification: 'SaaS',
          competitivePositioning: 'Leader',
          voiceProfile: { tone: ['bold'], style: ['direct'], avoidPatterns: [] },
          targetAudience: {
            demographics: { ageRange: '25-45' },
            psychographics: { painPoints: ['time'] },
          },
          valuePropositions: ['Speed'],
          messagingPillars: ['Innovation'],
          contentPillars: [{ name: 'Tech', weight: 0.5 }],
          _meta: { overallConfidence: 0.75, pagesScraped: 8, scrapingProvider: 'firecrawl' },
        })
      );

      const handler = server.getHandler('explain_brand_system')!;
      const result = await handler({});

      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({ action: 'brand-profile' })
      );

      const text = result.content[0].text;
      expect(text).toContain('Brand System Report: TestBrand');
      expect(text).toContain('Identity');
      expect(text).toContain('Extraction confidence: 75%');
    });

    it('returns not-found when no profile exists', async () => {
      mockCallEdge.mockResolvedValueOnce(brandProfileResponse(null));

      const handler = server.getHandler('explain_brand_system')!;
      const result = await handler({});

      expect(result.content[0].text).toContain('No brand profile found');
    });
  });

  // =========================================================================
  // check_brand_consistency
  // =========================================================================
  describe('check_brand_consistency', () => {
    it('checks content against brand vocabulary rules', async () => {
      mockCallEdge.mockResolvedValueOnce(
        brandProfileResponse({
          vocabularyRules: {
            preferredTerms: ['platform', 'solution'],
            bannedTerms: ['cheap', 'simple'],
          },
          voiceProfile: { avoidPatterns: ['click here'] },
        })
      );

      const handler = server.getHandler('check_brand_consistency')!;
      const result = await handler({
        content: 'Our cheap platform solution is simple. Click here!',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.bannedTermsFound).toContain('cheap');
      expect(parsed.data.bannedTermsFound).toContain('simple');
      expect(parsed.data.preferredTermsUsed).toContain('platform');
      expect(parsed.data.preferredTermsUsed).toContain('solution');
    });

    it('returns error when no profile exists', async () => {
      mockCallEdge.mockResolvedValueOnce(brandProfileResponse(null));

      const handler = server.getHandler('check_brand_consistency')!;
      const result = await handler({ content: 'test content' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No brand profile found');
    });

    it('detects fabrication patterns', async () => {
      mockCallEdge.mockResolvedValueOnce(
        brandProfileResponse({
          vocabularyRules: { preferredTerms: [], bannedTerms: [] },
          voiceProfile: { avoidPatterns: [] },
        })
      );

      const handler = server.getHandler('check_brand_consistency')!;
      const result = await handler({
        content: 'Our award-winning product is guaranteed to improve results by 50%.',
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.issues.length).toBeGreaterThan(0);
      expect(parsed.data.issues.some((i: string) => i.includes('unverified'))).toBe(true);
    });
  });
});
