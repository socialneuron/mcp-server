import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerIdeationTools } from './ideation.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('ideation tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerIdeationTools(server as any);
  });

  // =========================================================================
  // generate_content
  // =========================================================================
  describe('generate_content', () => {
    it('enriches prompt with platform, brand_voice, and content_type then calls social-neuron-ai', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { text: 'Generated script about AI tools' },
        error: null,
      });

      const handler = server.getHandler('generate_content')!;
      const result = await handler({
        prompt: 'Write a script about AI tools',
        content_type: 'script',
        platform: 'youtube',
        brand_voice: 'professional and empathetic',
      });

      expect(mockCallEdge).toHaveBeenCalledOnce();
      const [fnName, body, opts] = mockCallEdge.mock.calls[0];
      expect(fnName).toBe('social-neuron-ai');

      // Prompt should contain all enrichment parts
      const sentPrompt = body.prompt as string;
      expect(sentPrompt).toContain('Write a script about AI tools');
      expect(sentPrompt).toContain('Target Platform: youtube');
      expect(sentPrompt).toContain('Brand Voice: professional and empathetic');
      expect(sentPrompt).toContain('Content Type: script');

      // Body fields
      expect(body.contentType).toBe('script');
      expect(body.model).toBe('gemini-2.5-flash');
      expect(body.config).toEqual({ temperature: 0.8, maxOutputTokens: 4096 });

      // Timeout
      expect(opts).toEqual({ timeoutMs: 90_000 });

      // Result text
      expect(result.content[0].text).toBe('Generated script about AI tools');
    });

    it('returns isError on Edge Function failure', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'Rate limit exceeded',
      });

      const handler = server.getHandler('generate_content')!;
      const result = await handler({
        prompt: 'Write something',
        content_type: 'caption',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Content generation failed');
      expect(result.content[0].text).toContain('Rate limit exceeded');
    });

    it('auto-enriches prompt with brand and performance context when project_id is provided', async () => {
      mockCallEdge
        .mockResolvedValueOnce({
          data: {
            success: true,
            profile: {
              brand_name: 'Acme',
              brand_context: { industryClassification: 'SaaS' },
            },
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: {
            success: true,
            context: { promptInjection: 'Top hooks: Ask a bold question first.' },
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { text: 'Generated with enrichment' },
          error: null,
        });

      const handler = server.getHandler('generate_content')!;
      const result = await handler({
        prompt: 'Create a script',
        content_type: 'script',
        project_id: '11111111-1111-4111-8111-111111111111',
      });

      expect(mockCallEdge).toHaveBeenCalledTimes(3);
      expect(mockCallEdge.mock.calls[0][0]).toBe('mcp-data');
      expect(mockCallEdge.mock.calls[1][0]).toBe('mcp-data');
      expect(mockCallEdge.mock.calls[2][0]).toBe('social-neuron-ai');

      const finalPrompt = mockCallEdge.mock.calls[2][1].prompt as string;
      expect(finalPrompt).toContain('PROJECT BRAND CONTEXT');
      expect(finalPrompt).toContain('Brand: Acme');
      expect(finalPrompt).toContain('Industry: SaaS');
      expect(finalPrompt).toContain('PERFORMANCE INSIGHTS');
      expect(finalPrompt).toContain('Top hooks: Ask a bold question first.');
      expect(result.content[0].text).toContain('Generated with enrichment');
    });

    it('injects full voice profile and platform overrides into generation prompt', async () => {
      mockCallEdge
        .mockResolvedValueOnce({
          data: {
            success: true,
            profile: {
              brand_name: 'Acme',
              brand_context: {
                industryClassification: 'SaaS',
                voiceProfile: {
                  tone: ['professional'],
                  style: ['concise'],
                  languagePatterns: ['use active voice'],
                  avoidPatterns: ['clickbait'],
                  sampleContent: 'We help founders scale with practical systems.',
                  platformOverrides: {
                    linkedin: {
                      tone: ['authoritative'],
                      style: ['insightful'],
                      sampleContent: 'A short LinkedIn thought-leadership sample.',
                      ctaStyle: 'ask a question',
                      hashtagStrategy: '3-5 industry tags',
                      avoidPatterns: ['hype'],
                    },
                  },
                },
              },
            },
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { success: true, context: { promptInjection: '' } },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { text: 'Generated with full voice context' },
          error: null,
        });

      const handler = server.getHandler('generate_content')!;
      await handler({
        prompt: 'Create a post',
        content_type: 'caption',
        platform: 'linkedin',
        project_id: '11111111-1111-4111-8111-111111111111',
      });

      const finalPrompt = mockCallEdge.mock.calls[2][1].prompt as string;
      expect(finalPrompt).toContain('BRAND VOICE GUIDANCE');
      expect(finalPrompt).toContain('Tone: professional');
      expect(finalPrompt).toContain('Style: concise');
      expect(finalPrompt).toContain('Use these language patterns: use active voice');
      expect(finalPrompt).toContain('Avoid these patterns: clickbait');
      expect(finalPrompt).toContain('Voice samples:');
      expect(finalPrompt).toContain('Platform tone override: authoritative');
      expect(finalPrompt).toContain('Platform samples:');
      expect(finalPrompt).toContain('CTA style: ask a question');
      expect(finalPrompt).toContain('Hashtag strategy: 3-5 industry tags');
    });
  });

  // =========================================================================
  // fetch_trends
  // =========================================================================
  describe('fetch_trends', () => {
    it('requires url param when source is rss and returns isError without calling edge function', async () => {
      const handler = server.getHandler('fetch_trends')!;
      const result = await handler({ source: 'rss' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('url');
      expect(result.content[0].text).toContain('required');
      expect(result.content[0].text).toContain('rss');
      // Should NOT have called the edge function
      expect(mockCallEdge).not.toHaveBeenCalled();
    });

    it('formats trend list with view counts and descriptions', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          trends: [
            {
              title: 'AI Revolution 2026',
              views: 1500000,
              description:
                'How artificial intelligence is transforming every industry in unexpected ways',
              url: 'https://youtube.com/watch?v=abc',
              source: 'youtube',
            },
            {
              title: 'Best Productivity Tools',
              views: 250000,
              description: null,
              url: null,
              source: 'youtube',
            },
          ],
          source: 'youtube',
          category: 'tech',
          cached: false,
        },
        error: null,
      });

      const handler = server.getHandler('fetch_trends')!;
      const result = await handler({ source: 'youtube', category: 'tech' });

      const text = result.content[0].text;
      expect(text).toContain('Found 2 trends from youtube');
      expect(text).toContain('fresh');
      expect(text).toContain('AI Revolution 2026');
      expect(text).toContain('1,500,000 views');
      expect(text).toContain('How artificial intelligence');
      expect(text).toContain('https://youtube.com/watch?v=abc');
      expect(text).toContain('Best Productivity Tools');
      expect(text).toContain('250,000 views');
    });
  });

  // =========================================================================
  // adapt_content
  // =========================================================================
  describe('adapt_content', () => {
    it('includes platform guidelines in prompt and calls social-neuron-ai', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { text: 'Adapted caption for Twitter' },
        error: null,
      });

      const handler = server.getHandler('adapt_content')!;
      const result = await handler({
        content: 'Check out our new product launch! Amazing features for creators.',
        target_platform: 'twitter',
        source_platform: 'instagram',
        brand_voice: 'playful',
      });

      expect(mockCallEdge).toHaveBeenCalledOnce();
      const [fnName, body] = mockCallEdge.mock.calls[0];
      expect(fnName).toBe('social-neuron-ai');

      const sentPrompt = body.prompt as string;
      // Should contain platform-specific guidelines for Twitter
      expect(sentPrompt).toContain('Max 280 characters');
      expect(sentPrompt).toContain('twitter');
      // Should note the source platform
      expect(sentPrompt).toContain('Originally written for instagram');
      // Should include brand voice
      expect(sentPrompt).toContain('playful');
      // Should include the original content
      expect(sentPrompt).toContain('Check out our new product launch');

      // Output should have the adapted header
      const text = result.content[0].text;
      expect(text).toContain('Adapted for twitter');
      expect(text).toContain('from instagram');
      expect(text).toContain('Adapted caption for Twitter');
    });

    it('injects project platform voice overrides into adaptation prompt', async () => {
      mockCallEdge
        .mockResolvedValueOnce({
          data: {
            success: true,
            profile: {
              brand_context: {
                voiceProfile: {
                  avoidPatterns: ['spammy claims'],
                  platformOverrides: {
                    linkedin: {
                      sampleContent: 'LinkedIn sample voice with practical advice.',
                      ctaStyle: 'end with a thoughtful question',
                      hashtagStrategy: '2-4 niche hashtags',
                    },
                  },
                },
              },
            },
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { text: 'Adapted with voice overrides' },
          error: null,
        });

      const handler = server.getHandler('adapt_content')!;
      const result = await handler({
        content: 'Original draft content.',
        target_platform: 'linkedin',
        source_platform: 'twitter',
        project_id: '11111111-1111-4111-8111-111111111111',
      });

      expect(mockCallEdge.mock.calls[0][0]).toBe('mcp-data');
      expect(mockCallEdge.mock.calls[1][0]).toBe('social-neuron-ai');

      const sentPrompt = mockCallEdge.mock.calls[1][1].prompt as string;
      expect(sentPrompt).toContain('Additional voice guidance');
      expect(sentPrompt).toContain('Avoid these patterns: spammy claims');
      expect(sentPrompt).toContain('Match this platform style:');
      expect(sentPrompt).toContain('CTA style: end with a thoughtful question');
      expect(sentPrompt).toContain('Hashtag strategy: 2-4 niche hashtags');
      expect(result.content[0].text).toContain('Adapted with voice overrides');
    });
  });
});
