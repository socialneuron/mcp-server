import { applyScopeEnforcement, registerAllTools } from './register-tools.js';

export type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

type ToolHandler = (args?: Record<string, unknown>, extra?: unknown) => Promise<ToolResult> | ToolResult;

class CapturingToolServer {
  readonly handlers = new Map<string, ToolHandler>();
  readonly _registeredTools: Record<string, { update: (updates: Record<string, unknown>) => void }> =
    {};
  // ext-apps/app resource registrations are intentionally ignored by REST.
  readonly resources = new Map<string, unknown>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool(name: string, _description: string, schemaOrHandler: any, handler?: ToolHandler): void {
    if (typeof schemaOrHandler === 'function') {
      this.handlers.set(name, schemaOrHandler as ToolHandler);
      this._registeredTools[name] = { update: () => {} };
      return;
    }
    if (handler) {
      this.handlers.set(name, handler);
      this._registeredTools[name] = { update: () => {} };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool(name: string, _config: any, handler: ToolHandler): void {
    this.handlers.set(name, handler);
    this._registeredTools[name] = { update: () => {} };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerResource(name: string, uri: string, _metadata: any, handler: unknown): void {
    this.resources.set(`${name}:${uri}`, handler);
  }
}

export interface ToolExecutor {
  list(): string[];
  has(name: string): boolean;
  execute(name: string, args?: Record<string, unknown>, extra?: unknown): Promise<ToolResult>;
}

export function createToolExecutor(scopeResolver: () => string[]): ToolExecutor {
  const server = new CapturingToolServer();
  applyScopeEnforcement(server as never, scopeResolver);
  registerAllTools(server as never, {
    skipScreenshots: true,
    skipApps: true,
    skipLocalMediaPaths: true,
  });

  return {
    list: () => [...server.handlers.keys()],
    has: (name: string) => server.handlers.has(name),
    async execute(name: string, args?: Record<string, unknown>, extra?: unknown) {
      const handler = server.handlers.get(name);
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return handler(args ?? {}, extra);
    },
  };
}
