import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  launchBrowser,
  createPage,
  loginToApp,
  capturePageScreenshot,
  closeBrowser,
  APP_PAGES,
} from '../lib/browser.js';
import type { Viewport } from '../lib/browser.js';
import { resolve, relative } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { validateUrlForSSRF } from '../lib/ssrf.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { getDefaultUserId, logMcpToolInvocation } from '../lib/supabase.js';

export function registerScreenshotTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // capture_app_page
  // ---------------------------------------------------------------------------
  server.tool(
    'capture_app_page',
    'Navigate to a Social Neuron app page and take a full-page screenshot. ' +
      'Logs in with test credentials, navigates to the specified page, waits ' +
      'for content to load, then captures a screenshot. Output is saved to ' +
      'public/assets/screenshots/.',
    {
      page: z
        .enum([
          'dashboard',
          'ideation',
          'creation',
          'library',
          'distribution',
          'analytics',
          'automations',
          'settings',
          'storyboard',
          'video-editor',
          'avatar-lab',
          'brand-brain',
        ])
        .describe('App page to capture. Maps to internal route paths.'),
      viewport: z
        .enum(['desktop', 'mobile', 'tablet'])
        .optional()
        .describe(
          'Viewport size. desktop=1920x1080, mobile=390x844, tablet=768x1024. Defaults to desktop.'
        ),
      theme: z.enum(['light', 'dark']).optional().describe('Color theme. Defaults to light.'),
      selector: z
        .string()
        .optional()
        .describe('Optional CSS selector to capture a specific element instead of the full page.'),
      wait_ms: z
        .number()
        .min(0)
        .max(30_000)
        .optional()
        .describe(
          'Extra milliseconds to wait after page load before capturing. Useful for animations. Defaults to 2000.'
        ),
    },
    {
      title: "Capture App Page",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },

    async ({ page: pageName, viewport, theme, selector, wait_ms }) => {
      const startedAt = Date.now();
      let rateLimitKey = 'anonymous';
      try {
        rateLimitKey = await getDefaultUserId();
      } catch {
        // Some screenshot flows can run without an authenticated user context.
      }
      const rateLimit = checkRateLimit('screenshot', `capture_app_page:${rateLimitKey}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'capture_app_page',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const vp = (viewport ?? 'desktop') as Viewport;
      const appUrl = process.env.APP_URL || 'http://localhost:3000';
      const route = APP_PAGES[pageName];

      if (!route) {
        await logMcpToolInvocation({
          toolName: 'capture_app_page',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: 'Unknown page', pageName },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unknown page "${pageName}". Available: ${Object.keys(APP_PAGES).join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const browser = await launchBrowser();
        const browserPage = await createPage(browser, vp);

        // Set dark mode if requested
        if (theme === 'dark') {
          await browserPage.emulateMedia({ colorScheme: 'dark' });
        }

        await loginToApp(browserPage);
        await browserPage.goto(`${appUrl}${route}`, {
          waitUntil: 'networkidle',
        });

        // Wait for extra time if specified
        const waitTime = wait_ms ?? 2000;
        if (waitTime > 0) {
          await browserPage.waitForTimeout(waitTime);
        }

        // Build output path
        const outDir = resolve('public/assets/screenshots');
        await mkdir(outDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${pageName}-${vp}${theme === 'dark' ? '-dark' : ''}-${timestamp}.png`;
        const outputPath = resolve(outDir, filename);

        await capturePageScreenshot(browserPage, outputPath, selector);

        await browserPage.context().close();

        const relativePath = relative(resolve('.'), outputPath);
        await logMcpToolInvocation({
          toolName: 'capture_app_page',
          status: 'success',
          durationMs: Date.now() - startedAt,
          details: { pageName, viewport: vp, theme: theme ?? 'light' },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Screenshot captured successfully.`,
                `  Page: ${pageName} (${route})`,
                `  Viewport: ${vp}`,
                `  Theme: ${theme ?? 'light'}`,
                `  File: ${relativePath}`,
              ].join('\n'),
            },
          ],
        };
      } catch (err) {
        await closeBrowser();
        const message = err instanceof Error ? err.message : String(err);
        await logMcpToolInvocation({
          toolName: 'capture_app_page',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: message, pageName },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Screenshot capture failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // capture_screenshot
  // ---------------------------------------------------------------------------
  server.tool(
    'capture_screenshot',
    'Take a screenshot of any URL. Launches a headless Chromium browser, ' +
      'navigates to the URL, and captures either the full page or a specific ' +
      'CSS selector. No login is performed.',
    {
      url: z.string().describe('The URL to screenshot (e.g. https://example.com).'),
      viewport: z
        .enum(['desktop', 'mobile', 'tablet'])
        .optional()
        .describe('Viewport size. Defaults to desktop.'),
      selector: z
        .string()
        .optional()
        .describe('Optional CSS selector to capture a specific element instead of the full page.'),
      output_path: z
        .string()
        .optional()
        .describe(
          'Custom output file path. Defaults to public/assets/screenshots/<hostname>-<timestamp>.png.'
        ),
      wait_ms: z
        .number()
        .min(0)
        .max(30_000)
        .optional()
        .describe('Extra milliseconds to wait after page load before capturing. Defaults to 1000.'),
    },
    {
      title: "Capture Screenshot",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },

    async ({ url, viewport, selector, output_path, wait_ms }) => {
      const startedAt = Date.now();
      let rateLimitKey = 'anonymous';
      try {
        rateLimitKey = await getDefaultUserId();
      } catch {
        // Some screenshot flows can run without an authenticated user context.
      }
      const rateLimit = checkRateLimit('screenshot', `capture_screenshot:${rateLimitKey}`);
      if (!rateLimit.allowed) {
        await logMcpToolInvocation({
          toolName: 'capture_screenshot',
          status: 'rate_limited',
          durationMs: Date.now() - startedAt,
          details: { retryAfter: rateLimit.retryAfter },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Rate limit exceeded. Retry in ~${rateLimit.retryAfter}s.`,
            },
          ],
          isError: true,
        };
      }

      const vp = (viewport ?? 'desktop') as Viewport;

      // SSRF protection: validate the URL before navigating
      const ssrfResult = await validateUrlForSSRF(url);
      if (!ssrfResult.isValid) {
        await logMcpToolInvocation({
          toolName: 'capture_screenshot',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: ssrfResult.error, url },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `URL blocked by SSRF protection: ${ssrfResult.error}`,
            },
          ],
          isError: true,
        };
      }

      // DNS pinning: replace hostname with resolved IP to prevent DNS rebinding
      // between our validation check and Playwright's actual connection.
      let navigateUrl = ssrfResult.sanitizedUrl!;
      const parsedUrl = new URL(navigateUrl);
      const originalHost = parsedUrl.hostname;
      if (ssrfResult.resolvedIP) {
        const isIPv6 = ssrfResult.resolvedIP.includes(':');
        parsedUrl.hostname = isIPv6 ? `[${ssrfResult.resolvedIP}]` : ssrfResult.resolvedIP;
        navigateUrl = parsedUrl.toString();
      }

      try {
        const browser = await launchBrowser();
        const browserPage = await createPage(browser, vp);

        // If we pinned the IP, set the Host header so the target server
        // can route the request correctly (virtual hosting).
        if (ssrfResult.resolvedIP) {
          await browserPage.setExtraHTTPHeaders({ Host: originalHost });
        }

        await browserPage.goto(navigateUrl, {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });

        const waitTime = wait_ms ?? 1000;
        if (waitTime > 0) {
          await browserPage.waitForTimeout(waitTime);
        }

        const screenshotDir = resolve('public/assets/screenshots');
        let outputPath: string;
        if (output_path) {
          // Path traversal protection: resolved path must be inside screenshotDir
          outputPath = resolve(output_path);
          if (!outputPath.startsWith(screenshotDir + '/') && outputPath !== screenshotDir) {
            await browserPage.context().close();
            await logMcpToolInvocation({
              toolName: 'capture_screenshot',
              status: 'error',
              durationMs: Date.now() - startedAt,
              details: { error: 'Invalid output_path', outputPath },
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid output_path: must be inside public/assets/screenshots/. Path traversal is not allowed.`,
                },
              ],
              isError: true,
            };
          }
        } else {
          await mkdir(screenshotDir, { recursive: true });

          let hostname: string;
          try {
            hostname = new URL(url).hostname.replace(/[^a-zA-Z0-9-]/g, '_');
          } catch {
            hostname = 'screenshot';
          }
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          outputPath = resolve(screenshotDir, `${hostname}-${vp}-${timestamp}.png`);
        }

        // Ensure parent directory exists
        const parentDir = resolve(outputPath, '..');
        await mkdir(parentDir, { recursive: true });

        await capturePageScreenshot(browserPage, outputPath, selector);

        await browserPage.context().close();

        const relativePath = relative(resolve('.'), outputPath);
        await logMcpToolInvocation({
          toolName: 'capture_screenshot',
          status: 'success',
          durationMs: Date.now() - startedAt,
          details: { url: ssrfResult.sanitizedUrl, viewport: vp },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Screenshot captured successfully.`,
                `  URL: ${url}`,
                `  Viewport: ${vp}`,
                `  File: ${relativePath}`,
              ].join('\n'),
            },
          ],
        };
      } catch (err) {
        await closeBrowser();
        const message = err instanceof Error ? err.message : String(err);
        await logMcpToolInvocation({
          toolName: 'capture_screenshot',
          status: 'error',
          durationMs: Date.now() - startedAt,
          details: { error: message, url },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Screenshot capture failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
