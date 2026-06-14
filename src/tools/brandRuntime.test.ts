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

function v26FlatProfile() {
  return {
    name: 'Social Neuron',
    tagline: 'Content That Learns What Works',
    industryClassification: 'Marketing Technology',
    competitivePosition: 'Closed-loop content automation for teams that publish daily',
    logoVariants: {
      primary: 'https://socialneuron.com/logo-light.png',
      dark: 'https://socialneuron.com/logo-dark.png',
      icon: 'https://socialneuron.com/icon.png',
    },
    colorPalette: {
      primary: '#01E789',
      secondary: '#0A0A0F',
      accent: '#FFFFFF',
      background: '#0A0A0F',
    },
    typography: { headingFont: 'Inter', bodyFont: 'Manrope' },
    voiceTone: ['tech-forward', 'contrarian', 'founder-tone', 'plain-language'],
    voiceTags: ['terse', 'fragmented', 'analytical', 'operator', 'direct'],
    preferredTerms: [
      'brand brain',
      'content loop',
      'closed-loop analytics',
      'learning system',
      'autopilot',
      'creative system',
      'performance feedback',
      'content engine',
      'operator workflow',
    ],
    discouragedTerms: [
      'unleash',
      'leverage',
      'revolutionize',
      'synergy',
      'next-gen',
      'best-in-class',
    ],
    styleGuidance: [
      'Use terse paragraphs',
      'Prefer concrete operator language',
      'Lead with the system insight',
      'Use three-word value props',
      'Avoid generic AI hype',
      'Show the feedback loop',
    ],
    targetAudience: {
      personas: [
        {
          id: 'founder',
          name: 'SaaS founder',
          pains: ['manual content ops', 'unclear content ROI'],
          threeWordOutcomes: ['publish learn compound'],
        },
        {
          id: 'ecommerce',
          name: 'E-commerce operator',
          pains: ['campaign fatigue'],
          threeWordOutcomes: ['ship product stories'],
        },
        {
          id: 'creator',
          name: 'Creator operator',
          pains: ['inconsistent posting'],
          threeWordOutcomes: ['reuse winning ideas'],
        },
      ],
      secondaryAudience: 'agencies and fractional marketers',
      painPoints: ['blank page', 'content waste', 'weak distribution', 'no learning loop', 'slow QA'],
    },
    valueProp: 'Content operations that learn from performance',
    oneLiner: 'Social Neuron turns social publishing into a learning loop.',
    differentiators: [
      'generation',
      'distribution',
      'analytics',
      'insights',
      'brand memory',
    ],
    contentLifecycle: ['research', 'create', 'approve', 'publish', 'learn'],
    claimBoundaries: [
      'Do not claim LinkedIn publishing is live until the integration is enabled.',
      'Do not promise guaranteed follower growth.',
      'Do not imply fully autonomous publishing without approval controls.',
    ],
    platformsLive: ['YouTube', 'TikTok', 'Instagram', 'X'],
    platformsPending: ['LinkedIn', 'Facebook', 'Threads'],
    compliance: ['No unsupported performance guarantees', 'No fabricated customer metrics'],
  };
}

function v26FlatProfileResponse() {
  return {
    data: {
      success: true,
      profile: {
        brand_name: 'Social Neuron',
        version: 26,
        updated_at: '2026-05-25T00:00:00Z',
        overall_confidence: 0.85,
        extraction_metadata: null,
        profile_data: v26FlatProfile(),
      },
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

  describe('v26 flat profile compatibility', () => {
    it('returns runtime fields from a flat v26 profile', async () => {
      mockCallEdge.mockResolvedValueOnce(v26FlatProfileResponse());

      const handler = server.getHandler('get_brand_runtime')!;
      const result = await handler({});
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.data.name).toBe('Social Neuron');
      expect(parsed.data.voice.tone).toContain('tech-forward');
      expect(parsed.data.voice.style).toContain('operator');
      expect(parsed.data.voice.preferredTerms).toContain('brand brain');
      expect(parsed.data.voice.bannedTerms).toContain('unleash');
      expect(parsed.data.visual.colorPalette.primary).toBe('#01E789');
      expect(parsed.data.confidence.overall).toBe(0.85);
    });

    it('reports populated v26 sections instead of missing voice/audience/messaging/vocabulary', async () => {
      mockCallEdge.mockResolvedValueOnce(v26FlatProfileResponse());

      const handler = server.getHandler('explain_brand_system')!;
      const result = await handler({});
      const text = result.content[0].text;

      expect(text).toContain('Brand System Report: Social Neuron');
      expect(text).toContain('[OK] Voice');
      expect(text).toContain('[OK] Audience');
      expect(text).toContain('[OK] Messaging');
      expect(text).toContain('[OK] Vocabulary');
      expect(text).toContain('Extraction confidence: 85%');
      expect(text).not.toContain('Add preferred terms');
    });

    it('enforces v26 discouraged terms and pending platform claims', async () => {
      mockCallEdge.mockResolvedValueOnce(v26FlatProfileResponse());

      const handler = server.getHandler('check_brand_consistency')!;
      const result = await handler({
        content:
          'Unleash next-gen synergy! Our best-in-class platform will revolutionize your content workflow. Leverage AI to create posts in one click on LinkedIn today!',
      });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.data.bannedTermsFound).toEqual(
        expect.arrayContaining([
          'unleash',
          'leverage',
          'revolutionize',
          'synergy',
          'next-gen',
          'best-in-class',
        ])
      );
      expect(parsed.data.dimensions.avoidCompliance.score).toBeLessThan(100);
      expect(
        parsed.data.fabricationWarnings.some((warning: string) =>
          warning.includes('pending platform claim')
        )
      ).toBe(true);
    });

    it('audits colors from a flat v26 palette', async () => {
      mockCallEdge.mockResolvedValueOnce(v26FlatProfileResponse());

      const handler = server.getHandler('audit_brand_colors')!;
      const result = await handler({ content_colors: ['#01E789', '#FF4444'] });
      const parsed = JSON.parse(result.content[0].text);

      expect(result.isError).not.toBe(true);
      expect(parsed.data.entries).toHaveLength(2);
      expect(parsed.data.entries[0].passed).toBe(true);
      expect(parsed.data.entries[1].passed).toBe(false);
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
      expect(parsed.data.fabricationWarnings.length).toBeGreaterThan(0);
      expect(parsed.data.fabricationWarnings.some((w: string) => w.includes('unverified'))).toBe(
        true
      );
      expect(parsed.data.overall).toBeDefined();
      expect(parsed.data.dimensions).toBeDefined();
      expect(parsed.data.dimensions.toneAlignment).toBeDefined();
      expect(parsed.data.dimensions.avoidCompliance).toBeDefined();
    });
  });

  // =========================================================================
  // audit_brand_colors
  // =========================================================================
  describe('audit_brand_colors', () => {
    it('audits content colors against brand palette', async () => {
      mockCallEdge.mockResolvedValueOnce(
        brandProfileResponse({
          colorPalette: { primary: '#0053A0', secondary: '#ffffff', accent: '#FF6600' },
        })
      );

      const handler = server.getHandler('audit_brand_colors')!;
      const result = await handler({ content_colors: ['#0053A0', '#ff00ff'] });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.entries).toHaveLength(2);
      expect(parsed.data.entries[0].passed).toBe(true); // exact match
      expect(parsed.data.entries[1].passed).toBe(false); // magenta is off-brand
      expect(parsed.data.overallScore).toBeDefined();
    });

    it('returns error when no palette exists', async () => {
      mockCallEdge.mockResolvedValueOnce(brandProfileResponse({ name: 'Test' }));

      const handler = server.getHandler('audit_brand_colors')!;
      const result = await handler({ content_colors: ['#000'] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No brand color palette');
    });
  });

  // =========================================================================
  // export_design_tokens
  // =========================================================================
  describe('export_design_tokens', () => {
    it('exports CSS variables', async () => {
      mockCallEdge.mockResolvedValueOnce(
        brandProfileResponse({
          colorPalette: { primary: '#0053A0', secondary: '#ffffff', accent: '#FF6600' },
          typography: { headingFont: 'Inter', bodyFont: 'Open Sans' },
        })
      );

      const handler = server.getHandler('export_design_tokens')!;
      const result = await handler({ format: 'css' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.format).toBe('css');
      expect(parsed.data.tokens).toContain('--brand-primary');
      expect(parsed.data.tokens).toContain('#0053A0');
      expect(parsed.data.tokens).toContain('Inter');
    });

    it('exports Tailwind config', async () => {
      mockCallEdge.mockResolvedValueOnce(
        brandProfileResponse({
          colorPalette: { primary: '#000', secondary: '#fff', accent: '#f00' },
        })
      );

      const handler = server.getHandler('export_design_tokens')!;
      const result = await handler({ format: 'tailwind' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.format).toBe('tailwind');
      const tokens = JSON.parse(parsed.data.tokens);
      expect(tokens['brand-primary']).toBe('#000');
    });

    it('exports Figma tokens', async () => {
      mockCallEdge.mockResolvedValueOnce(
        brandProfileResponse({
          colorPalette: { primary: '#123', secondary: '#456', accent: '#789' },
          typography: { headingFont: 'Roboto' },
        })
      );

      const handler = server.getHandler('export_design_tokens')!;
      const result = await handler({ format: 'figma' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.format).toBe('figma');
      const tokens = JSON.parse(parsed.data.tokens);
      expect(tokens.color.primary.type).toBe('color');
      expect(tokens.fontFamily.heading.value).toBe('Roboto');
    });

    it('returns error when no palette exists', async () => {
      mockCallEdge.mockResolvedValueOnce(brandProfileResponse({ name: 'Test' }));

      const handler = server.getHandler('export_design_tokens')!;
      const result = await handler({ format: 'css' });

      expect(result.isError).toBe(true);
    });
  });
});
