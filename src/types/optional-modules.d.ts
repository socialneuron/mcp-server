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
    goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
    fill(selector: string, value: string): Promise<unknown>;
    click(selector: string): Promise<unknown>;
    waitForURL(url: string, options?: Record<string, unknown>): Promise<unknown>;
    waitForTimeout(timeoutMs: number): Promise<void>;
    emulateMedia(options?: { colorScheme?: 'dark' | 'light' | 'no-preference' | null }): Promise<void>;
    setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
    context(): BrowserContext;
    $(selector: string): Promise<ElementHandle | null>;
    screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  }

  export interface ElementHandle {
    screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  }

  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<Browser>;
  };
}

declare module '@remotion/bundler' {
  export function bundle(options: {
    entryPoint: string;
    onProgress?: (...args: unknown[]) => void;
  }): Promise<string>;
}

declare module '@remotion/renderer' {
  export interface Composition {
    durationInFrames: number;
    fps: number;
    width: number;
    height: number;
  }

  export function selectComposition(options: {
    serveUrl: string;
    id: string;
    inputProps?: Record<string, unknown>;
  }): Promise<Composition>;

  export function renderMedia(options: {
    composition: Composition;
    serveUrl: string;
    codec: 'gif' | 'h264';
    outputLocation: string;
    inputProps?: Record<string, unknown>;
  }): Promise<void>;
}
