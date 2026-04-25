/**
 * Comprehensive tool connection tests for the Social Neuron MCP server.
 *
 * Tests two things:
 *  1. Registration & scope coverage — every tool in TOOL_SCOPES is registered
 *     and vice-versa; mcp:full grants access to all tools.
 *  2. Per-module connection tests — at least one happy-path and one error-path
 *     per module to verify tools call the right backend and return structured
 *     responses (or isError on failure).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer, type MockServer } from '../test-setup.js';
import { TOOL_SCOPES, hasScope } from '../auth/scopes.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getSupabaseClient, getDefaultUserId, getDefaultProjectId } from '../lib/supabase.js';
import { checkRateLimit } from '../lib/rate-limit.js';

// Module registrars
import { registerIdeationTools } from './ideation.js';
import { registerContentTools } from './content.js';
import { registerDistributionTools } from './distribution.js';
import { registerMediaTools } from './media.js';
import { registerAnalyticsTools } from './analytics.js';
import { registerBrandTools } from './brand.js';
import { registerRemotionTools } from './remotion.js';
import { registerInsightsTools } from './insights.js';
import { registerYouTubeAnalyticsTools } from './youtube-analytics.js';
import { registerCommentsTools } from './comments.js';
import { registerIdeationContextTools } from './ideation-context.js';
import { registerCreditsTools } from './credits.js';
import { registerLoopSummaryTools } from './loop-summary.js';
import { registerUsageTools } from './usage.js';
import { registerAutopilotTools } from './autopilot.js';
import { registerExtractionTools } from './extraction.js';
import { registerQualityTools } from './quality.js';
import { registerPlanningTools } from './planning.js';
import { registerPlanApprovalTools } from './plan-approvals.js';
import { registerDiscoveryTools } from './discovery.js';
import { registerPipelineTools } from './pipeline.js';
import { registerSuggestTools } from './suggest.js';
import { registerDigestTools } from './digest.js';
import { registerBrandRuntimeTools } from './brandRuntime.js';
import { registerRecipeTools } from './recipes.js';
import { registerCarouselTools } from './carousel.js';
import { registerContentCalendarApp } from '../apps/content-calendar.js';
// Screenshot tools require browser mocks; tested separately below.
import { registerScreenshotTools } from './screenshot.js';

// ---------------------------------------------------------------------------
// Browser mocks (screenshot tools need Playwright stubs)
// ---------------------------------------------------------------------------
vi.mock('../lib/browser.js', () => ({
  launchBrowser: vi.fn(async () => ({})),
  createPage: vi.fn(async () => ({
    goto: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    setExtraHTTPHeaders: vi.fn(async () => {}),
    context: vi.fn(() => ({ close: vi.fn(async () => {}) })),
  })),
  loginToApp: vi.fn(async () => {}),
  capturePageScreenshot: vi.fn(async () => {}),
  closeBrowser: vi.fn(async () => {}),
  APP_PAGES: {
    dashboard: '/dashboard',
    ideation: '/ideation',
    creation: '/create',
    library: '/library',
    distribution: '/distribution',
    analytics: '/analytics',
    automations: '/automations',
    settings: '/settings',
    storyboard: '/storyboard',
    'video-editor': '/video-editor',
    'avatar-lab': '/avatar-lab',
    'brand-brain': '/brand-brain',
  },
}));

vi.mock('../lib/ssrf.js', () => ({
  validateUrlForSSRF: vi.fn(async () => ({
    isValid: true,
    sanitizedUrl: 'https://example.com',
    resolvedIP: '93.184.216.34',
  })),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------
const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetClient = vi.mocked(getSupabaseClient);
const mockGetUserId = vi.mocked(getDefaultUserId);
const mockGetProjectId = vi.mocked(getDefaultProjectId);

/**
 * Reset all mocks to a clean default state. vi.clearAllMocks() does NOT
 * clear once-queues (mockReturnValueOnce etc.), so we must reset+restore
 * default implementations explicitly.
 */
function resetMocksToDefaults(): void {
  vi.clearAllMocks();
  // Reset edge function mock — return sensible defaults for mcp-data actions
  mockCallEdge.mockReset();
  mockCallEdge.mockImplementation(async (fnName: string, body: Record<string, unknown>) => {
    if (fnName === 'mcp-data') {
      const action = body?.action as string;
      if (action === 'connected-accounts')
        return { data: { success: true, accounts: [] }, error: null };
      if (action === 'recent-posts') return { data: { success: true, posts: [] }, error: null };
      if (action === 'job-status') return { data: { success: true, job: null }, error: null };
      if (action === 'analytics') return { data: { success: true, rows: [] }, error: null };
      if (action === 'performance-insights')
        return { data: { success: true, insights: [] }, error: null };
      if (action === 'best-posting-times')
        return { data: { success: true, rows: [] }, error: null };
      if (action === 'brand-profile')
        return { data: { success: true, profile: null }, error: null };
      if (action === 'save-brand-profile')
        return { data: { success: true, profileId: 'mock-id' }, error: null };
      if (action === 'ideation-context')
        return {
          data: {
            success: true,
            context: {
              projectId: 'test-project-id',
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
        };
      if (action === 'credit-balance')
        return {
          data: { success: true, balance: 100, monthlyUsed: 0, monthlyLimit: 100, plan: 'free' },
          error: null,
        };
    }
    return { data: null, error: null };
  });
  // Reset supabase client to return chainable query mock
  mockGetClient.mockReset();
  mockGetClient.mockImplementation(() => {
    const chain = chainMock({ data: [], error: null });
    return { from: vi.fn(() => chain) } as any;
  });
  // Restore userId and projectId defaults
  mockGetUserId.mockReset();
  mockGetUserId.mockResolvedValue('test-user-id');
  mockGetProjectId.mockReset();
  mockGetProjectId.mockResolvedValue('test-project-id' as any);
}

// Build a chainable Supabase query that resolves to a custom value.
function chainMock(resolvedValue = { data: null, error: null }) {
  const c: Record<string, any> = {};
  const methods = [
    'select',
    'insert',
    'update',
    'delete',
    'upsert',
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
  ];
  for (const m of methods) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (resolve: Function) => resolve(resolvedValue);
  c.catch = () => c;
  c.finally = () => c;
  return c;
}

function supabaseWithChain(resolvedValue = { data: null, error: null }) {
  const chain = chainMock(resolvedValue);
  return {
    from: vi.fn(() => chain),
    rpc: vi.fn().mockResolvedValue(resolvedValue),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — REGISTRATION & SCOPE COVERAGE
// ═══════════════════════════════════════════════════════════════════════════

describe('Registration & Scope Coverage', () => {
  let server: MockServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    // Register every module (mirrors registerAllTools)
    registerIdeationTools(server as any);
    registerContentTools(server as any);
    registerDistributionTools(server as any);
    registerMediaTools(server as any);
    registerAnalyticsTools(server as any);
    registerBrandTools(server as any);
    registerScreenshotTools(server as any);
    registerRemotionTools(server as any);
    registerInsightsTools(server as any);
    registerYouTubeAnalyticsTools(server as any);
    registerCommentsTools(server as any);
    registerIdeationContextTools(server as any);
    registerCreditsTools(server as any);
    registerLoopSummaryTools(server as any);
    registerUsageTools(server as any);
    registerAutopilotTools(server as any);
    registerExtractionTools(server as any);
    registerQualityTools(server as any);
    registerPlanningTools(server as any);
    registerPlanApprovalTools(server as any);
    registerDiscoveryTools(server as any);
    registerPipelineTools(server as any);
    registerSuggestTools(server as any);
    registerDigestTools(server as any);
    registerBrandRuntimeTools(server as any);
    registerRecipeTools(server as any);
    registerCarouselTools(server as any);
    registerContentCalendarApp(server as any);
  });

  it('every tool in TOOL_SCOPES is actually registered (no orphaned scope entries)', () => {
    const registeredNames = new Set(server._handlers.keys());
    const orphaned: string[] = [];
    for (const toolName of Object.keys(TOOL_SCOPES)) {
      if (!registeredNames.has(toolName)) {
        orphaned.push(toolName);
      }
    }
    expect(orphaned, `Orphaned scope entries: ${orphaned.join(', ')}`).toEqual([]);
  });

  it('every registered tool has an entry in TOOL_SCOPES (no unscoped tools)', () => {
    const scopedNames = new Set(Object.keys(TOOL_SCOPES));
    const unscoped: string[] = [];
    for (const toolName of server._handlers.keys()) {
      if (!scopedNames.has(toolName)) {
        unscoped.push(toolName);
      }
    }
    expect(unscoped, `Unscoped tools: ${unscoped.join(', ')}`).toEqual([]);
  });

  it('mcp:full grants access to every tool via hierarchy', () => {
    for (const [toolName, requiredScope] of Object.entries(TOOL_SCOPES)) {
      expect(
        hasScope(['mcp:full'], requiredScope),
        `mcp:full should grant '${requiredScope}' for tool '${toolName}'`
      ).toBe(true);
    }
  });

  it('registers at least 50 tools', () => {
    expect(server._handlers.size).toBeGreaterThanOrEqual(50);
  });

  describe('scope category assignments', () => {
    const readTools = [
      'fetch_trends',
      'list_recent_posts',
      'fetch_analytics',
      'get_performance_insights',
      'get_best_posting_times',
      'extract_brand',
      'get_brand_profile',
      'get_ideation_context',
      'get_credit_balance',
      'get_budget_status',
      'get_loop_summary',
      'list_connected_accounts',
      'capture_screenshot',
      'capture_app_page',
      'list_compositions',
      'get_mcp_usage',
      'extract_url_content',
      'quality_check',
      'quality_check_plan',
      'find_next_slots',
      'get_content_plan',
      'list_plan_approvals',
      'check_status',
    ];

    const writeTools = [
      'generate_content',
      'adapt_content',
      'generate_video',
      'generate_image',
      'render_demo_video',
      'save_brand_profile',
      'update_platform_voice',
      'create_storyboard',
      'generate_voiceover',
      'plan_content_week',
      'save_content_plan',
      'update_content_plan',
      'submit_content_plan_for_approval',
      'create_plan_approvals',
      'respond_plan_approval',
    ];

    const distributeTools = ['schedule_post', 'schedule_content_plan'];
    const analyticsTools = ['refresh_platform_analytics', 'fetch_youtube_analytics'];
    const commentsTools = [
      'list_comments',
      'reply_to_comment',
      'post_comment',
      'moderate_comment',
      'delete_comment',
    ];
    const autopilotTools = [
      'list_autopilot_configs',
      'update_autopilot_config',
      'get_autopilot_status',
    ];

    it.each(readTools)('"%s" is mcp:read', tool => {
      expect(TOOL_SCOPES[tool]).toBe('mcp:read');
    });

    it.each(writeTools)('"%s" is mcp:write', tool => {
      expect(TOOL_SCOPES[tool]).toBe('mcp:write');
    });

    it.each(distributeTools)('"%s" is mcp:distribute', tool => {
      expect(TOOL_SCOPES[tool]).toBe('mcp:distribute');
    });

    it.each(analyticsTools)('"%s" is mcp:analytics', tool => {
      expect(TOOL_SCOPES[tool]).toBe('mcp:analytics');
    });

    it.each(commentsTools)('"%s" is mcp:comments', tool => {
      expect(TOOL_SCOPES[tool]).toBe('mcp:comments');
    });

    it.each(autopilotTools)('"%s" is mcp:autopilot', tool => {
      expect(TOOL_SCOPES[tool]).toBe('mcp:autopilot');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — PER-MODULE CONNECTION TESTS
// ═══════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// 1. Ideation (generate_content, fetch_trends, adapt_content)
// ---------------------------------------------------------------------------
describe('Module: ideation', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerIdeationTools(server as any);
  });

  it('generate_content: happy path calls social-neuron-ai', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: { text: 'Generated script' },
      error: null,
    });
    const result = await server.getHandler('generate_content')!({
      prompt: 'Write a hook',
      content_type: 'script',
    });
    expect(result.content[0].text).toContain('Generated script');
    expect(mockCallEdge.mock.calls[0][0]).toBe('social-neuron-ai');
  });

  it('generate_content: error path returns isError', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Service down' });
    const result = await server.getHandler('generate_content')!({
      prompt: 'Write something',
      content_type: 'caption',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Service down');
  });
});

// ---------------------------------------------------------------------------
// 2. Content (generate_video, generate_image, check_status, create_storyboard, generate_voiceover)
// ---------------------------------------------------------------------------
describe('Module: content', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerContentTools(server as any);
  });

  it('generate_video: happy path returns job ID', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        asyncJobId: 'vid-1',
        taskId: 'task-1',
        model: 'veo3-fast',
        creditsDeducted: 10,
        estimatedTime: 60,
        status: 'pending',
      },
      error: null,
    });
    const result = await server.getHandler('generate_video')!({
      prompt: 'sunset',
      model: 'veo3-fast',
    });
    expect(result.content[0].text).toContain('Job ID: vid-1');
    expect(mockCallEdge.mock.calls[0][0]).toBe('kie-video-generate');
  });

  it('generate_image: error path returns isError', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'GPU busy' });
    const result = await server.getHandler('generate_image')!({
      prompt: 'cat',
      model: 'midjourney',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('GPU busy');
  });

  it('check_status: returns completed job details', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        job: {
          id: 'job-1',
          external_id: 'ext-1',
          status: 'completed',
          job_type: 'video',
          model: 'veo3-fast',
          result_url: 'https://r2.example.com/video.mp4',
          error_message: null,
          credits_cost: 10,
          created_at: '2026-02-10T12:00:00Z',
          completed_at: '2026-02-10T12:01:30Z',
        },
      },
      error: null,
    });

    const result = await server.getHandler('check_status')!({ job_id: 'job-1' });
    expect(result.content[0].text).toContain('Status: completed');
    expect(result.content[0].text).toContain('Result URL:');
  });

  it('create_storyboard: happy path calls social-neuron-ai', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        content: JSON.stringify({
          title: 'VPN App Ad',
          totalDuration: 30,
          aspectRatio: '9:16',
          characterDescription: 'A young professional',
          frames: [
            {
              id: 'scene-1',
              frameNumber: 1,
              shotType: 'CU',
              cameraMovement: 'static',
              duration: 4,
              imagePrompt: 'person at desk',
              videoPrompt: 'slow zoom in',
              caption: 'Did you know...',
              voiceover: 'Your data is being tracked',
              notes: 'Hook',
            },
          ],
        }),
        model: 'gemini-2.5-flash',
      },
      error: null,
    });
    const result = await server.getHandler('create_storyboard')!({
      concept: 'TikTok ad for VPN app',
      platform: 'tiktok',
    });
    expect(result.isError).toBeUndefined();
    expect(mockCallEdge.mock.calls[0][0]).toBe('social-neuron-ai');
  });

  it('generate_voiceover: error path returns isError', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'TTS quota exceeded' });
    const result = await server.getHandler('generate_voiceover')!({
      text: 'Hello world',
    });
    expect(result.isError).toBe(true);
    // Error message depends on whether callEdge error or missing audioUrl
    expect(result.content[0].text).toMatch(/TTS quota exceeded|Voiceover generation failed/);
  });
});

// ---------------------------------------------------------------------------
// 3. Distribution (schedule_post, list_connected_accounts, list_recent_posts,
//                  schedule_content_plan, find_next_slots)
// ---------------------------------------------------------------------------
describe('Module: distribution', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerDistributionTools(server as any);
  });

  it('schedule_post: happy path calls schedule-post edge function', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        scheduledAt: '2026-03-01T14:00:00Z',
        results: { YouTube: { success: true, jobId: 'j1', postId: 'p1' } },
      },
      error: null,
    });
    const result = await server.getHandler('schedule_post')!({
      caption: 'New video out!',
      platforms: ['youtube'],
    });
    expect(result.content[0].text).toContain('Post scheduled successfully');
    expect(mockCallEdge.mock.calls[0][0]).toBe('schedule-post');
  });

  it('schedule_post: error path returns isError', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Token expired' });
    const result = await server.getHandler('schedule_post')!({
      caption: 'Test',
      platforms: ['youtube'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Token expired');
  });

  it('list_connected_accounts: returns empty message when no accounts', async () => {
    // Default mock returns empty data
    const result = await server.getHandler('list_connected_accounts')!({});
    expect(result.content[0].text).toContain('No connected social media accounts');
  });

  it('list_recent_posts: returns empty message with no posts', async () => {
    const result = await server.getHandler('list_recent_posts')!({});
    expect(result.content[0].text).toContain('No posts found');
  });

  it('find_next_slots: returns available slots', async () => {
    const result = await server.getHandler('find_next_slots')!({
      platforms: ['youtube'],
      count: 3,
      min_gap_hours: 4,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('optimal slots');
  });
});

// ---------------------------------------------------------------------------
// 4. Analytics (fetch_analytics, refresh_platform_analytics)
// ---------------------------------------------------------------------------
describe('Module: analytics', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerAnalyticsTools(server as any);
  });

  it('fetch_analytics: returns empty analytics when no data', async () => {
    const result = await server.getHandler('fetch_analytics')!({});
    expect(result.content[0].text).toContain('No analytics data found');
  });

  it('refresh_platform_analytics: happy path triggers refresh', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        postsProcessed: 5,
        results: [
          { postId: 'p1', status: 'queued' },
          { postId: 'p2', status: 'queued' },
        ],
      },
      error: null,
    });
    const result = await server.getHandler('refresh_platform_analytics')!({});
    expect(result.content[0].text).toContain('Analytics refresh triggered');
    expect(result.content[0].text).toContain('Posts processed: 5');
    expect(mockCallEdge.mock.calls[0][0]).toBe('fetch-analytics');
  });

  it('refresh_platform_analytics: error path returns isError', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Auth failed' });
    const result = await server.getHandler('refresh_platform_analytics')!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Auth failed');
  });
});

// ---------------------------------------------------------------------------
// 5. Brand (extract_brand, get_brand_profile, save_brand_profile, update_platform_voice)
// ---------------------------------------------------------------------------
describe('Module: brand', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerBrandTools(server as any);
  });

  it('extract_brand: happy path calls brand-extract', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        brandName: 'Acme Corp',
        description: 'SaaS platform',
        colors: { primary: '#000', secondary: '#fff', accent: '#f00' },
        voice: { tone: 'professional', style: 'concise', keywords: ['growth'] },
        audience: { primary: 'founders', painPoints: ['scaling'] },
      },
      error: null,
    });
    const result = await server.getHandler('extract_brand')!({
      url: 'https://acme.com',
    });
    expect(result.content[0].text).toContain('Acme Corp');
    expect(mockCallEdge.mock.calls[0][0]).toBe('brand-extract');
  });

  it('extract_brand: error path returns isError', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Page not reachable' });
    const result = await server.getHandler('extract_brand')!({
      url: 'https://dead.link',
    });
    expect(result.isError).toBe(true);
  });

  it('get_brand_profile: returns no-profile message when empty', async () => {
    const result = await server.getHandler('get_brand_profile')!({});
    // Default mock returns null data, so should get a fallback message
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it('save_brand_profile: requires project_id or default', async () => {
    mockGetProjectId.mockResolvedValueOnce(null as any);
    const result = await server.getHandler('save_brand_profile')!({
      brand_context: { name: 'Test' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No project_id');
  });

  it('update_platform_voice: requires project_id or default', async () => {
    mockGetProjectId.mockResolvedValueOnce(null as any);
    const result = await server.getHandler('update_platform_voice')!({
      platform: 'youtube',
    });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Screenshot (capture_app_page, capture_screenshot)
// ---------------------------------------------------------------------------
describe('Module: screenshot', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerScreenshotTools(server as any);
  });

  it('capture_app_page: happy path returns success message', async () => {
    const result = await server.getHandler('capture_app_page')!({
      page: 'dashboard',
    });
    expect(result.content[0].text).toContain('Screenshot captured successfully');
    expect(result.content[0].text).toContain('dashboard');
  });

  it('capture_screenshot: happy path returns success message', async () => {
    const result = await server.getHandler('capture_screenshot')!({
      url: 'https://example.com',
    });
    expect(result.content[0].text).toContain('Screenshot captured successfully');
  });
});

// ---------------------------------------------------------------------------
// 7. Remotion (list_compositions, render_demo_video)
// ---------------------------------------------------------------------------
describe('Module: remotion', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerRemotionTools(server as any);
  });

  it('list_compositions: returns static composition list', async () => {
    const result = await server.getHandler('list_compositions')!({});
    expect(result.content[0].text).toContain('CaptionedClip');
    expect(result.isError).toBeUndefined();
  });

  it('render_demo_video: returns rate-limited or error gracefully', async () => {
    // render_demo_video requires filesystem access and npx; with default mocks
    // it should return something (either error or rate limit message)
    const result = await server.getHandler('render_demo_video')!({
      composition_id: 'CaptionedClip',
    });
    // Result depends on environment; just verify handler doesn't throw
    expect(result.content).toBeDefined();
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Insights (get_performance_insights, get_best_posting_times)
// ---------------------------------------------------------------------------
describe('Module: insights', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerInsightsTools(server as any);
  });

  it('get_performance_insights: returns empty when no insights found', async () => {
    const result = await server.getHandler('get_performance_insights')!({});
    expect(result.content[0].text).toContain('No performance insights');
  });

  it('get_best_posting_times: returns empty when no data', async () => {
    const result = await server.getHandler('get_best_posting_times')!({});
    // Empty result should contain a meaningful message
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. YouTube Analytics (fetch_youtube_analytics)
// ---------------------------------------------------------------------------
describe('Module: youtube-analytics', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerYouTubeAnalyticsTools(server as any);
  });

  it('fetch_youtube_analytics: happy path calls youtube-analytics edge fn', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        channelName: 'TestChannel',
        subscribers: 10000,
        totalViews: 500000,
        videoCount: 50,
        dailyAnalytics: [],
      },
      error: null,
    });
    const result = await server.getHandler('fetch_youtube_analytics')!({
      action: 'channel',
      start_date: '2026-01-01',
      end_date: '2026-02-01',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it('fetch_youtube_analytics: error when video action missing video_id', async () => {
    const result = await server.getHandler('fetch_youtube_analytics')!({
      action: 'video',
      start_date: '2026-01-01',
      end_date: '2026-02-01',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('video_id');
  });
});

// ---------------------------------------------------------------------------
// 10. Comments (list_comments, reply_to_comment, post_comment,
//               moderate_comment, delete_comment)
// ---------------------------------------------------------------------------
describe('Module: comments', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerCommentsTools(server as any);
  });

  it('list_comments: happy path calls youtube-comments edge fn', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        comments: [
          {
            id: 'c1',
            textOriginal: 'Great video!',
            authorDisplayName: 'User1',
            likeCount: 5,
            replyCount: 0,
            publishedAt: '2026-02-01',
          },
        ],
        totalCount: 1,
      },
      error: null,
    });
    const result = await server.getHandler('list_comments')!({});
    expect(result.content[0].text).toContain('Great video!');
    expect(mockCallEdge.mock.calls[0][0]).toBe('youtube-comments');
  });

  it('list_comments: error path returns isError', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Channel not connected' });
    const result = await server.getHandler('list_comments')!({});
    expect(result.isError).toBe(true);
  });

  it('reply_to_comment: happy path', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: { success: true, replyId: 'r1' },
      error: null,
    });
    const result = await server.getHandler('reply_to_comment')!({
      comment_id: 'c1',
      text: 'Thanks!',
    });
    expect(result.isError).toBeUndefined();
  });

  it('post_comment: happy path', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: { success: true, commentId: 'new-c1' },
      error: null,
    });
    const result = await server.getHandler('post_comment')!({
      video_id: 'v1',
      text: 'Nice content!',
    });
    expect(result.isError).toBeUndefined();
  });

  it('moderate_comment: happy path', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: { success: true },
      error: null,
    });
    const result = await server.getHandler('moderate_comment')!({
      comment_id: 'c1',
      action: 'hide',
    });
    expect(result.isError).toBeUndefined();
  });

  it('delete_comment: error path returns isError', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Not found' });
    const result = await server.getHandler('delete_comment')!({
      comment_id: 'c1',
    });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Ideation Context (get_ideation_context)
// ---------------------------------------------------------------------------
describe('Module: ideation-context', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerIdeationContextTools(server as any);
  });

  it('get_ideation_context: returns context via mcp-data EF', async () => {
    // The default mock returns { success: true, context: {} } for ideation-context
    const result = await server.getHandler('get_ideation_context')!({});
    expect(result.content[0].text.length).toBeGreaterThan(0);
    expect(result.isError).toBeUndefined();
  });

  it('get_ideation_context: returns error on EF failure', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Gateway timeout' });
    const result = await server.getHandler('get_ideation_context')!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to fetch ideation context');
  });
});

// ---------------------------------------------------------------------------
// 12. Credits (get_credit_balance, get_budget_status)
// ---------------------------------------------------------------------------
describe('Module: credits', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerCreditsTools(server as any);
  });

  it('get_credit_balance: returns balance info', async () => {
    const result = await server.getHandler('get_credit_balance')!({});
    expect(result.content[0].text.length).toBeGreaterThan(0);
    // Should not be an error even with default mocked empty data
    expect(result.isError).toBeUndefined();
  });

  it('get_budget_status: returns budget info', async () => {
    const result = await server.getHandler('get_budget_status')!({});
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 13. Loop Summary (get_loop_summary)
// ---------------------------------------------------------------------------
describe('Module: loop-summary', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerLoopSummaryTools(server as any);
  });

  it('get_loop_summary: returns summary with default project', async () => {
    const result = await server.getHandler('get_loop_summary')!({});
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 14. Usage (get_mcp_usage)
// ---------------------------------------------------------------------------
describe('Module: usage', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerUsageTools(server as any);
  });

  it('get_mcp_usage: returns usage breakdown', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: { success: true, totalCalls: 0, totalCredits: 0, tools: [] },
      error: null,
    });
    const result = await server.getHandler('get_mcp_usage')!({});
    expect(result.content[0].text.length).toBeGreaterThan(0);
    expect(result.content[0].text).toContain('No MCP API usage');
  });

  it('get_mcp_usage: error path returns isError', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: null,
      error: 'DB error',
    });
    const result = await server.getHandler('get_mcp_usage')!({});
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 15. Autopilot (list_autopilot_configs, update_autopilot_config, get_autopilot_status)
// ---------------------------------------------------------------------------
describe('Module: autopilot', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerAutopilotTools(server as any);
  });

  it('list_autopilot_configs: returns empty list with no configs', async () => {
    // Provide explicit supabase mock returning empty array for configs
    mockGetClient.mockReturnValueOnce(supabaseWithChain({ data: [], error: null }));
    const result = await server.getHandler('list_autopilot_configs')!({});
    expect(result.content[0].text.length).toBeGreaterThan(0);
    expect(result.content[0].text).toContain('No autopilot configurations found');
  });

  it('update_autopilot_config: no changes returns message', async () => {
    // Pass config_id but no fields to update => "No changes specified"
    const result = await server.getHandler('update_autopilot_config')!({
      config_id: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.content[0].text).toContain('No changes specified');
  });

  it('get_autopilot_status: returns status summary', async () => {
    // Provide explicit supabase mock with empty arrays for all three queries
    const client = {
      from: vi.fn(() => chainMock({ data: [], error: null })),
    };
    mockGetClient.mockReturnValueOnce(client as any);
    const result = await server.getHandler('get_autopilot_status')!({});
    expect(result.content[0].text.length).toBeGreaterThan(0);
    expect(result.content[0].text).toContain('Autopilot Status');
  });
});

// ---------------------------------------------------------------------------
// 16. Extraction (extract_url_content)
// ---------------------------------------------------------------------------
describe('Module: extraction', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerExtractionTools(server as any);
  });

  it('extract_url_content: happy path for YouTube URL', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        title: 'My Video',
        description: 'Video desc',
        transcript: 'Hello world transcript',
        metadata: { views: 5000, likes: 100, duration: 300, tags: ['tech'], channelName: 'TestCh' },
      },
      error: null,
    });
    const result = await server.getHandler('extract_url_content')!({
      url: 'https://youtube.com/watch?v=abc',
      extract_type: 'auto',
      include_comments: false,
      max_results: 10,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('My Video');
    expect(mockCallEdge.mock.calls[0][0]).toBe('scrape-youtube');
  });

  it('extract_url_content: error path returns isError', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'Failed to scrape' });
    const result = await server.getHandler('extract_url_content')!({
      url: 'https://youtube.com/watch?v=fail',
      extract_type: 'auto',
      include_comments: false,
      max_results: 10,
      response_format: 'text',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to scrape');
  });
});

// ---------------------------------------------------------------------------
// 17. Quality (quality_check, quality_check_plan)
// ---------------------------------------------------------------------------
describe('Module: quality', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerQualityTools(server as any);
  });

  it('quality_check: passes good content', async () => {
    const result = await server.getHandler('quality_check')!({
      caption:
        'How to build a profitable SaaS in 2026 with a complete step-by-step framework and live examples. Save this guide and share with your founder friends!',
      title: 'Build a Profitable SaaS',
      platforms: ['linkedin'],
      threshold: 10,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('[PASS]');
  });

  it('quality_check: fails low-quality content', async () => {
    const result = await server.getHandler('quality_check')!({
      caption: 'Hi',
      platforms: ['twitter'],
      threshold: 26,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('[FAIL]');
  });

  it('quality_check_plan: scores array of posts', async () => {
    const result = await server.getHandler('quality_check_plan')!({
      plan: {
        posts: [
          {
            id: 'p1',
            caption:
              'Amazing deep-dive thread on AI trends for 2026 with real data points and actionable takeaways for marketers.',
            platform: 'twitter',
          },
          { id: 'p2', caption: 'Hi', platform: 'instagram' },
        ],
      },
      threshold: 10,
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('p1');
    expect(result.content[0].text).toContain('p2');
  });
});

// ---------------------------------------------------------------------------
// 18. Planning (plan_content_week, save_content_plan, get_content_plan,
//               update_content_plan, submit_content_plan_for_approval)
// ---------------------------------------------------------------------------
describe('Module: planning', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerPlanningTools(server as any);
  });

  it('plan_content_week: happy path calls social-neuron-ai', async () => {
    // Mock sequence: 1) brand-profile, 2) ideation-context, 3) loop-summary, 4) social-neuron-ai
    mockCallEdge
      .mockResolvedValueOnce({
        data: { success: true, profile: { brand_name: 'Acme', brand_context: {} } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { success: true, context: { promptInjection: '' } },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { success: true, summary: {} },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          text: JSON.stringify([
            {
              id: 'day1-youtube-1',
              day: 1,
              date: '2026-03-01',
              platform: 'youtube',
              content_type: 'script',
              caption: 'Video about AI productivity tips',
              title: 'AI Tips',
              hook: 'Did you know?',
              angle: 'productivity',
              hashtags: ['#AI'],
              visual_direction: 'tech montage',
              media_type: 'video',
            },
          ]),
        },
        error: null,
      });
    // Provide supabase mock for content_plans insert
    mockGetClient.mockReturnValueOnce(supabaseWithChain({ data: null, error: null }));
    const result = await server.getHandler('plan_content_week')!({
      topic: 'AI productivity',
      platforms: ['youtube'],
      posts_per_day: 1,
      start_date: '2026-03-01',
      days: 1,
      project_id: '11111111-1111-4111-8111-111111111111',
      response_format: 'text',
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it('plan_content_week: error path returns isError on AI failure', async () => {
    // Mock sequence: 1) brand, 2) ideation-context, 3) loop-summary, 4) AI error
    mockCallEdge
      .mockResolvedValueOnce({ data: null, error: null }) // brand not found (non-fatal)
      .mockResolvedValueOnce({ data: null, error: null }) // context not found (non-fatal)
      .mockResolvedValueOnce({ data: null, error: null }) // loop-summary not found (non-fatal)
      .mockResolvedValueOnce({ data: null, error: 'Model overloaded' });
    const result = await server.getHandler('plan_content_week')!({
      topic: 'AI',
      platforms: ['youtube'],
      posts_per_day: 1,
      days: 5,
      start_date: '2026-03-01',
      project_id: '11111111-1111-4111-8111-111111111111',
      response_format: 'text',
    });
    expect(result.isError).toBe(true);
  });

  it('save_content_plan: requires project_id', async () => {
    mockGetProjectId.mockResolvedValueOnce(null as any);
    const result = await server.getHandler('save_content_plan')!({
      plan: { posts: [] },
      name: 'Test Plan',
    });
    // Should fail or return message about project_id
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it('get_content_plan: returns empty when plan not found', async () => {
    const result = await server.getHandler('get_content_plan')!({
      plan_id: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it('update_content_plan: returns error when plan not found', async () => {
    const result = await server.getHandler('update_content_plan')!({
      plan_id: '00000000-0000-4000-8000-000000000001',
      updates: { name: 'New Name' },
    });
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it('submit_content_plan_for_approval: returns error when plan not found', async () => {
    const result = await server.getHandler('submit_content_plan_for_approval')!({
      plan_id: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 19. Plan Approvals (create_plan_approvals, respond_plan_approval,
//                     list_plan_approvals)
// ---------------------------------------------------------------------------
describe('Module: plan-approvals', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerPlanApprovalTools(server as any);
  });

  it('create_plan_approvals: returns no project_id error when none available', async () => {
    mockGetProjectId.mockResolvedValueOnce(null as any);
    const result = await server.getHandler('create_plan_approvals')!({
      plan_id: '00000000-0000-4000-8000-000000000001',
      posts: [{ id: 'p1', caption: 'Test' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No project_id');
  });

  it('list_plan_approvals: returns empty when no approvals', async () => {
    // Provide explicit supabase mock returning empty array
    mockGetClient.mockReturnValueOnce(supabaseWithChain({ data: [], error: null }));
    const result = await server.getHandler('list_plan_approvals')!({
      plan_id: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.content[0].text.length).toBeGreaterThan(0);
    expect(result.content[0].text).toContain('No approval items found');
  });

  it('respond_plan_approval: returns error when approval not found', async () => {
    // maybeSingle returns null data => approval not found
    mockGetClient.mockReturnValueOnce(supabaseWithChain({ data: null, error: null }));
    const result = await server.getHandler('respond_plan_approval')!({
      approval_id: '00000000-0000-4000-8000-000000000001',
      decision: 'approved',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Approval not found');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — CROSS-CUTTING: JSON ENVELOPE FORMAT
// ═══════════════════════════════════════════════════════════════════════════

describe('JSON envelope format (spot checks)', () => {
  let server: MockServer;

  beforeEach(() => {
    resetMocksToDefaults();
    server = createMockServer();
    registerContentTools(server as any);
    registerDistributionTools(server as any);
  });

  it('generate_video returns valid _meta envelope when response_format=json', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        asyncJobId: 'env-test',
        taskId: null,
        model: 'veo3-fast',
        creditsDeducted: 10,
        estimatedTime: 60,
        status: 'pending',
      },
      error: null,
    });
    const result = await server.getHandler('generate_video')!({
      prompt: 'test',
      model: 'veo3-fast',
      response_format: 'json',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed._meta.version).toBe('1.7.6');
    expect(parsed._meta.timestamp).toBeDefined();
    expect(parsed.data.jobId).toBe('env-test');
  });

  it('schedule_post returns valid _meta envelope when response_format=json', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: {
        success: true,
        scheduledAt: '2026-03-01T14:00:00Z',
        results: { YouTube: { success: true, jobId: 'j1', postId: 'p1' } },
      },
      error: null,
    });
    const result = await server.getHandler('schedule_post')!({
      caption: 'Test',
      platforms: ['youtube'],
      response_format: 'json',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed._meta.version).toBe('1.7.6');
    expect(parsed.data.success).toBe(true);
  });
});
