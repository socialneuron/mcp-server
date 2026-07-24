import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMockServer } from '../test-setup.js';

const ORIGINAL_MAX_CREDITS = process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN;
const ORIGINAL_MAX_ASSETS = process.env.SOCIALNEURON_MAX_ASSETS_PER_RUN;

describe('create_carousel budget enforcement', () => {
  afterEach(() => {
    if (ORIGINAL_MAX_CREDITS === undefined) {
      delete process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN;
    } else {
      process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN = ORIGINAL_MAX_CREDITS;
    }

    if (ORIGINAL_MAX_ASSETS === undefined) {
      delete process.env.SOCIALNEURON_MAX_ASSETS_PER_RUN;
    } else {
      process.env.SOCIALNEURON_MAX_ASSETS_PER_RUN = ORIGINAL_MAX_ASSETS;
    }

    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock('../lib/edge-function.js');
    vi.doUnmock('../lib/supabase.js');
  });

  it('rejects a carousel batch when requested slides exceed the remaining asset budget', async () => {
    vi.resetModules();
    process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN = '10000';
    process.env.SOCIALNEURON_MAX_ASSETS_PER_RUN = '1';

    const callEdgeFunction = vi.fn();
    vi.doMock('../lib/edge-function.js', () => ({ callEdgeFunction }));
    vi.doMock('../lib/supabase.js', async importOriginal => {
      const actual = await importOriginal<typeof import('../lib/supabase.js')>();
      return {
        ...actual,
        getSupabaseClient: vi.fn(),
        getDefaultUserId: vi.fn().mockResolvedValue('user_test_123'),
        getDefaultProjectId: vi.fn().mockResolvedValue(null),
      };
    });

    const { registerCarouselTools } = await import('./carousel.js');
    const server = createMockServer();
    registerCarouselTools(server as any);

    const result = await server.getHandler('create_carousel')!({
      topic: 'asset cap bypass regression',
      image_model: 'flux-pro',
      slide_count: 3,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Asset budget exceeded');
    expect(result.content[0].text).toContain('next=3');
    expect(callEdgeFunction).not.toHaveBeenCalledWith(
      'kie-image-generate',
      expect.anything(),
      expect.anything()
    );
    expect(callEdgeFunction).not.toHaveBeenCalledWith(
      'generate-carousel',
      expect.anything(),
      expect.anything()
    );
  });

  it('rechecks the actual returned slide count before starting image jobs', async () => {
    vi.resetModules();
    process.env.SOCIALNEURON_MAX_CREDITS_PER_RUN = '10000';
    process.env.SOCIALNEURON_MAX_ASSETS_PER_RUN = '1';

    const callEdgeFunction = vi.fn().mockResolvedValueOnce({
      data: {
        carousel: {
          id: 'carousel_extra_slides',
          slides: [
            { slideNumber: 1, headline: 'Slide 1' },
            { slideNumber: 2, headline: 'Slide 2' },
          ],
          credits: { estimated: 12, used: 12 },
        },
      },
      error: null,
    });
    vi.doMock('../lib/edge-function.js', () => ({ callEdgeFunction }));
    vi.doMock('../lib/supabase.js', async importOriginal => {
      const actual = await importOriginal<typeof import('../lib/supabase.js')>();
      return {
        ...actual,
        getSupabaseClient: vi.fn(),
        getDefaultUserId: vi.fn().mockResolvedValue('user_test_123'),
        getDefaultProjectId: vi.fn().mockResolvedValue(null),
      };
    });

    const { registerCarouselTools } = await import('./carousel.js');
    const server = createMockServer();
    registerCarouselTools(server as any);

    const result = await server.getHandler('create_carousel')!({
      topic: 'actual slide count regression',
      image_model: 'flux-pro',
      slide_count: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Asset budget exceeded');
    expect(result.content[0].text).toContain('next=2');
    expect(callEdgeFunction).toHaveBeenCalledWith(
      'generate-carousel',
      expect.anything(),
      expect.anything()
    );
    expect(callEdgeFunction).not.toHaveBeenCalledWith(
      'kie-image-generate',
      expect.anything(),
      expect.anything()
    );
  });
});
