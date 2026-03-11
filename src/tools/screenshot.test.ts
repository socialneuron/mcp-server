import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { registerScreenshotTools } from './screenshot.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { logMcpToolInvocation } from '../lib/supabase.js';
import { validateUrlForSSRF } from '../lib/ssrf.js';

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

const mockRateLimit = vi.mocked(checkRateLimit);
const mockLog = vi.mocked(logMcpToolInvocation);
const mockSSRF = vi.mocked(validateUrlForSSRF);

describe('screenshot tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerScreenshotTools(server as any);
  });

  // =========================================================================
  // capture_screenshot
  // =========================================================================
  describe('capture_screenshot', () => {
    it('succeeds and returns screenshot path for valid URL', async () => {
      const handler = server.getHandler('capture_screenshot')!;
      const result = await handler({ url: 'https://example.com' });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Screenshot captured successfully');
      expect(text).toContain('URL: https://example.com');
      expect(text).toContain('Viewport: desktop');
    });

    it('calls SSRF validation before navigating', async () => {
      const handler = server.getHandler('capture_screenshot')!;
      await handler({ url: 'https://example.com' });

      expect(mockSSRF).toHaveBeenCalledWith('https://example.com');
    });

    it('blocks URL when SSRF validation fails', async () => {
      mockSSRF.mockResolvedValueOnce({
        isValid: false,
        error: 'Access to internal/localhost addresses is not allowed.',
      });

      const handler = server.getHandler('capture_screenshot')!;
      const result = await handler({ url: 'http://localhost:3000' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('URL blocked by SSRF protection');
      expect(result.content[0].text).toContain('internal/localhost');
    });

    it('blocks private IP addresses via SSRF', async () => {
      mockSSRF.mockResolvedValueOnce({
        isValid: false,
        error: 'Access to private/internal IP addresses is not allowed.',
      });

      const handler = server.getHandler('capture_screenshot')!;
      const result = await handler({ url: 'http://192.168.1.1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('URL blocked by SSRF protection');
    });

    it('returns rate limit error when rate limited', async () => {
      mockRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 25 });

      const handler = server.getHandler('capture_screenshot')!;
      const result = await handler({ url: 'https://example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Rate limit exceeded');
      expect(result.content[0].text).toContain('25s');
    });

    it('returns isError on browser failure', async () => {
      const { launchBrowser } = await import('../lib/browser.js');
      vi.mocked(launchBrowser).mockRejectedValueOnce(new Error('Playwright is not installed'));

      const handler = server.getHandler('capture_screenshot')!;
      const result = await handler({ url: 'https://example.com' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Screenshot capture failed');
      expect(result.content[0].text).toContain('Playwright is not installed');
    });
  });

  // =========================================================================
  // capture_app_page
  // =========================================================================
  describe('capture_app_page', () => {
    it('succeeds and navigates to correct route', async () => {
      const handler = server.getHandler('capture_app_page')!;
      const result = await handler({ page: 'ideation' });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Screenshot captured successfully');
      expect(text).toContain('Page: ideation (/ideation)');
      expect(text).toContain('Viewport: desktop');
      expect(text).toContain('Theme: light');
    });

    it('returns error for unknown page name', async () => {
      // The page param is validated by zod enum, but if somehow bypassed:
      // We test with a page value that is NOT in APP_PAGES mock.
      // Since the tool checks APP_PAGES[pageName], any key not in the map returns undefined.
      const { APP_PAGES } = await import('../lib/browser.js');
      // Temporarily remove a key to simulate unknown page
      const original = APP_PAGES['dashboard'];
      delete APP_PAGES['dashboard'];

      const handler = server.getHandler('capture_app_page')!;
      const result = await handler({ page: 'dashboard' });

      // Restore
      APP_PAGES['dashboard'] = original;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown page');
    });

    it('returns rate limit error when rate limited', async () => {
      mockRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 15 });

      const handler = server.getHandler('capture_app_page')!;
      const result = await handler({ page: 'analytics' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Rate limit exceeded');
      expect(result.content[0].text).toContain('15s');
    });

    it('calls emulateMedia for dark theme', async () => {
      const { createPage } = await import('../lib/browser.js');
      const mockEmulate = vi.fn(async () => {});
      vi.mocked(createPage).mockResolvedValueOnce({
        goto: vi.fn(async () => {}),
        waitForTimeout: vi.fn(async () => {}),
        emulateMedia: mockEmulate,
        setExtraHTTPHeaders: vi.fn(async () => {}),
        context: vi.fn(() => ({ close: vi.fn(async () => {}) })),
      } as any);

      const handler = server.getHandler('capture_app_page')!;
      const result = await handler({ page: 'settings', theme: 'dark' });

      expect(result.isError).toBeUndefined();
      expect(mockEmulate).toHaveBeenCalledWith({ colorScheme: 'dark' });
      expect(result.content[0].text).toContain('Theme: dark');
    });

    it('returns isError on browser failure', async () => {
      const { launchBrowser } = await import('../lib/browser.js');
      vi.mocked(launchBrowser).mockRejectedValueOnce(new Error('Browser launch timeout'));

      const handler = server.getHandler('capture_app_page')!;
      const result = await handler({ page: 'library' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Screenshot capture failed');
      expect(result.content[0].text).toContain('Browser launch timeout');
    });
  });
});
