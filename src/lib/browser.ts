import type { Browser, Page } from 'playwright';

export type Viewport = 'desktop' | 'mobile' | 'tablet';

const VIEWPORT_SIZES: Record<Viewport, { width: number; height: number }> = {
  desktop: { width: 1920, height: 1080 },
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
};

export const APP_PAGES: Record<string, string> = {
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
};

let browserInstance: Browser | null = null;

export async function launchBrowser(): Promise<Browser> {
  if (browserInstance?.isConnected()) {
    return browserInstance;
  }
  let chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    throw new Error(
      'Playwright is not installed. Screenshot tools require it.\n' +
        'Install with: npm install playwright && npx playwright install chromium'
    );
  }
  browserInstance = await chromium.launch({ headless: true });
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance?.isConnected()) {
    await browserInstance.close();
    browserInstance = null;
  }
}

export async function createPage(browser: Browser, viewport: Viewport = 'desktop'): Promise<Page> {
  const context = await browser.newContext({
    viewport: VIEWPORT_SIZES[viewport],
  });
  return context.newPage();
}

export async function loginToApp(page: Page): Promise<void> {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const email = process.env.APP_EMAIL;
  const password = process.env.APP_PASSWORD;

  if (!email || !password) {
    throw new Error('APP_EMAIL and APP_PASSWORD environment variables are required for app login');
  }

  await page.goto(`${appUrl}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard**', { timeout: 15_000 });
}

export async function capturePageScreenshot(
  page: Page,
  outputPath: string,
  selector?: string
): Promise<string> {
  if (selector) {
    const element = await page.$(selector);
    if (!element) {
      throw new Error(`Selector "${selector}" not found on page`);
    }
    await element.screenshot({ path: outputPath });
  } else {
    await page.screenshot({ path: outputPath, fullPage: true });
  }
  return outputPath;
}
