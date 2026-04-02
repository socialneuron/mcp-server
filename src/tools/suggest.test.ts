import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerSuggestTools } from './suggest.js';
import { callEdgeFunction } from '../lib/edge-function.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('suggest tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerSuggestTools(server as any);
  });

  describe('suggest_next_content', () => {
    it('returns suggestions with data quality assessment', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          insights: [
            {
              insight_type: 'top_hooks',
              insight_data: {
                hooks: ['Why most people fail at...', 'The secret to...'],
                platform: 'tiktok',
              },
              confidence_score: 0.8,
              generated_at: '2026-03-18T10:00:00Z',
            },
          ],
          recentContent: [
            {
              topic: 'AI tips',
              platform: 'tiktok',
              content_type: 'caption',
              created_at: '2026-03-17',
            },
          ],
          swipeItems: [],
        },
        error: null,
      });

      const handler = server.getHandler('suggest_next_content')!;
      const result = await handler({ count: 3 });
      const text = result.content[0].text;
      expect(text).toContain('Content Suggestions');
      expect(text).toContain('Data Quality:');
    });

    it('returns JSON format', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, insights: [], recentContent: [], swipeItems: [] },
        error: null,
      });

      const handler = server.getHandler('suggest_next_content')!;
      const result = await handler({ count: 2, response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed._meta.version).toBeDefined();
      expect(parsed.data.suggestions).toBeDefined();
      expect(parsed.data.data_quality).toBeDefined();
    });

    it('classifies data quality as weak with no insights', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, insights: [], recentContent: [], swipeItems: [] },
        error: null,
      });

      const handler = server.getHandler('suggest_next_content')!;
      const result = await handler({ count: 1, response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.data_quality).toBe('weak');
    });

    it('classifies data quality as strong with many insights', async () => {
      const insights = Array.from({ length: 12 }, (_, i) => ({
        insight_type: 'top_hooks',
        insight_data: { hooks: [`Hook ${i}`] },
        confidence_score: 0.7,
        generated_at: '2026-03-18T10:00:00Z',
      }));

      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, insights, recentContent: [], swipeItems: [] },
        error: null,
      });

      const handler = server.getHandler('suggest_next_content')!;
      const result = await handler({ count: 2, response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.data_quality).toBe('strong');
    });

    it('includes at least one suggestion even with no data', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, insights: [], recentContent: [], swipeItems: [] },
        error: null,
      });

      const handler = server.getHandler('suggest_next_content')!;
      const result = await handler({ count: 3, response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.data.suggestions.length).toBeGreaterThanOrEqual(1);
    });

    it('uses swipe file for competitor-inspired suggestions', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: {
          success: true,
          insights: [],
          recentContent: [],
          swipeItems: [
            {
              title: '10 mistakes new creators make',
              hook: 'Stop doing this!',
              platform: 'instagram',
              engagement_score: 95,
              saved_at: '2026-03-15',
            },
          ],
        },
        error: null,
      });

      const handler = server.getHandler('suggest_next_content')!;
      const result = await handler({ count: 3, response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      const competitorSuggestion = parsed.data.suggestions.find((s: any) =>
        s.based_on.includes('niche_swipe_file')
      );
      expect(competitorSuggestion).toBeDefined();
    });

    it('handles errors gracefully', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: null,
        error: 'DB connection failed',
      });

      const handler = server.getHandler('suggest_next_content')!;
      const result = await handler({ count: 3 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Suggestion failed');
    });

    it('calls mcp-data with correct action', async () => {
      mockCallEdge.mockResolvedValueOnce({
        data: { success: true, insights: [], recentContent: [], swipeItems: [] },
        error: null,
      });

      const handler = server.getHandler('suggest_next_content')!;
      await handler({ count: 3 });
      expect(mockCallEdge).toHaveBeenCalledWith(
        'mcp-data',
        expect.objectContaining({
          action: 'suggest-content',
        })
      );
    });
  });
});
