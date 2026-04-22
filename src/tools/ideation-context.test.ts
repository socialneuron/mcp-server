import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerIdeationContextTools } from './ideation-context.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId } from '../lib/supabase.js';

const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetProjectId = vi.mocked(getDefaultProjectId);

describe('ideation context tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerIdeationContextTools(server as any);
    mockGetProjectId.mockResolvedValue('proj-1' as any);
  });

  it('returns transformed context via mcp-data EF', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        context: {
          projectId: 'proj-1',
          hasHistoricalData: true,
          promptInjection: 'Hooks perform strongly Use kling-3-pro',
          recommendedModel: 'kling-3-pro',
          recommendedDuration: 30,
          winningPatterns: { hookTypes: ['Hook A', 'Hook B'], contentFormats: [], ctaStyles: [] },
          topHooks: ['Hook A', 'Hook B'],
          insightsCount: 2,
        },
      },
      error: null,
    });

    const handler = server.getHandler('get_ideation_context')!;
    const result = await handler({});

    const text = result.content[0].text;
    expect(text).toContain('historical data available');
    expect(text).toContain('kling-3-pro');
    expect(text).toContain('Hook A');
    expect(mockCallEdge).toHaveBeenCalledWith(
      'mcp-data',
      expect.objectContaining({ action: 'ideation-context', projectId: 'proj-1' })
    );
  });

  it('returns response envelope when response_format=json', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        context: {
          projectId: 'proj-1',
          hasHistoricalData: false,
          promptInjection: '',
          recommendedModel: 'kling-2.0-master',
          recommendedDuration: 30,
          winningPatterns: { hookTypes: [], contentFormats: [], ctaStyles: [] },
          topHooks: [],
          insightsCount: 0,
        },
      },
      error: null,
    });

    const handler = server.getHandler('get_ideation_context')!;
    const result = await handler({ response_format: 'json' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed._meta.version).toBe('1.7.5');
    expect(parsed.data.hasHistoricalData).toBe(false);
  });
});
