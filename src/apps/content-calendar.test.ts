import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockServer } from '../test-setup.js';
import { registerContentCalendarApp } from './content-calendar.js';

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    stat: vi.fn(),
  },
}));

const METADATA_URI = 'socialneuron://apps/content-calendar/metadata';
const HTML_URI = 'ui://content-calendar/mcp-app.html';

describe('content calendar MCP App resources', () => {
  const mockStat = vi.mocked(fs.stat);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers compact metadata for the large HTML bundle', async () => {
    mockStat.mockResolvedValueOnce({ size: 345_190 } as Awaited<ReturnType<typeof fs.stat>>);

    const server = createMockServer();
    registerContentCalendarApp(server as any);

    const handler = server._resources.get(METADATA_URI);
    expect(handler).toBeDefined();

    const result = await handler!();
    const text = result.contents[0].text;
    const parsed = JSON.parse(text);

    expect(text.length).toBeLessThan(2_000);
    expect(parsed.app).toMatchObject({
      tool: 'open_content_calendar',
      html_resource_uri: HTML_URI,
      metadata_resource_uri: METADATA_URI,
    });
    expect(parsed.bundle).toMatchObject({
      built: true,
      bytes: 345_190,
      large_resource: true,
      model_readable: false,
    });
    expect(parsed.safety).toMatchObject({
      content_kind: 'mcp_app_html_bundle',
      model_readable: false,
      large_resource: true,
    });
    expect(text).not.toContain('<html');
  });

  it('reports missing app builds without reading or returning HTML', async () => {
    mockStat.mockRejectedValueOnce(new Error('missing bundle'));

    const server = createMockServer();
    registerContentCalendarApp(server as any);

    const result = await server._resources.get(METADATA_URI)!();
    const text = result.contents[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.bundle).toMatchObject({
      built: false,
      bytes: null,
      large_resource: true,
      model_readable: false,
    });
    expect(parsed.bundle.recovery).toContain('npm run build:app');
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(text).not.toContain('<html');
  });
});
