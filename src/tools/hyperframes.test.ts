import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callEdgeFunction } from '../lib/edge-function.js';
import { createMockServer } from '../test-setup.js';
import { registerHyperframesTools } from './hyperframes.js';

const mockCallEdge = vi.mocked(callEdgeFunction);

describe('hyperframes tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerHyperframesTools(server as never);
  });

  it('queues a project-scoped render and reports the live runtime contract', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: { jobId: 'hf-1', status: 'queued', creditsCost: 5 },
      error: null,
    });

    const result = await server.getHandler('render_hyperframes')!({
      composition_html: '<html><body>Test</body></html>',
      duration_sec: 1,
      quality: 'draft',
      project_id: 'project-123',
    });

    expect(mockCallEdge).toHaveBeenCalledWith(
      'create-hyperframes-job',
      expect.objectContaining({ projectId: 'project-123' })
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Job ID: hf-1');
    expect(result.content[0].text).not.toContain('Phase 2');
  });

  it('returns a stable JSON job handoff for agents and SDK callers', async () => {
    mockCallEdge.mockResolvedValueOnce({
      data: { jobId: 'hf-json-1', status: 'queued', creditsCost: 5 },
      error: null,
    });

    const result = await server.getHandler('render_hyperframes')!({
      composition_html: '<html><body>Test</body></html>',
      duration_sec: 1,
      quality: 'draft',
      project_id: 'project-123',
      response_format: 'json',
    });

    expect(JSON.parse(result.content[0].text)).toEqual({
      data: expect.objectContaining({
        job_id: 'hf-json-1',
        jobId: 'hf-json-1',
        credits_cost: 5,
        project_id: 'project-123',
      }),
    });
  });
});
