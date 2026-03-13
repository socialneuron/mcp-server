// Ambient module declarations for optional dependencies.
// These packages are dynamically imported at runtime and only needed
// when specific tools are invoked (screenshots, local video rendering).

declare module 'playwright' {
  export interface Browser {
    isConnected(): boolean;
    close(): Promise<void>;
    newContext(options?: { viewport?: { width: number; height: number } }): Promise<BrowserContext>;
  }

  export interface BrowserContext {
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }

  export interface Page {
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
    fill(selector: string, value: string): Promise<void>;
    click(selector: string): Promise<void>;
    waitForURL(url: string, options?: { timeout?: number }): Promise<void>;
    waitForTimeout(timeout: number): Promise<void>;
    $(selector: string): Promise<ElementHandle | null>;
    screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
    emulateMedia(options: { colorScheme?: string; media?: string }): Promise<void>;
    setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
    context(): BrowserContext;
  }

  export interface ElementHandle {
    screenshot(options?: { path?: string }): Promise<Buffer>;
  }

  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<Browser>;
  };
}

declare module '@remotion/bundler' {
  export function bundle(options: {
    entryPoint: string;
    onProgress?: (progress: number) => void;
  }): Promise<string>;
}

declare module '@remotion/renderer' {
  export function selectComposition(options: {
    serveUrl: string;
    id: string;
    inputProps?: Record<string, unknown>;
  }): Promise<{ durationInFrames: number; fps: number; height: number; width: number; id: string }>;

  export function renderMedia(options: {
    composition: { durationInFrames: number; fps: number; height: number; width: number; id: string };
    serveUrl: string;
    codec: string;
    outputLocation: string;
    inputProps?: Record<string, unknown>;
    onProgress?: (progress: { progress: number }) => void;
  }): Promise<void>;
}
