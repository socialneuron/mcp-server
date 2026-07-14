import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockServer } from '../test-setup.js';
import { callEdgeFunction } from '../lib/edge-function.js';
import { getDefaultProjectId } from '../lib/supabase.js';
import { registerLifecycleTools } from './lifecycle.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OBJECT_ID = '22222222-2222-4222-8222-222222222222';
const mockCallEdge = vi.mocked(callEdgeFunction);
const mockGetProject = vi.mocked(getDefaultProjectId);

describe('lifecycle cleanup tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProject.mockResolvedValue(PROJECT_ID);
    server = createMockServer();
    registerLifecycleTools(server as any);
  });

  it.each([
    ['cancel_async_job', 'cancel-async-job', 'job_id'],
    ['cancel_scheduled_post', 'cancel-scheduled-post', 'post_id'],
    ['delete_carousel', 'delete-carousel', 'content_id'],
    ['delete_content_plan', 'delete-content-plan', 'plan_id'],
    ['delete_autopilot_config', 'delete-autopilot-config', 'config_id'],
  ])('project-scopes %s and forwards its identifier', async (tool, action, idField) => {
    mockCallEdge.mockResolvedValueOnce({ data: { success: true, deleted: true }, error: null });
    const result = await server.getHandler(tool)!({
      [idField]: OBJECT_ID,
      confirm: true,
    });

    expect(result.isError).toBeUndefined();
    expect(mockCallEdge).toHaveBeenCalledWith('mcp-data', {
      action,
      projectId: PROJECT_ID,
      project_id: PROJECT_ID,
      [idField]: OBJECT_ID,
    });
  });

  it('does not call the backend without a project context', async () => {
    mockGetProject.mockResolvedValueOnce(null);
    const result = await server.getHandler('delete_content_plan')!({
      plan_id: OBJECT_ID,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.error_type).toBe('validation_error');
    expect(mockCallEdge).not.toHaveBeenCalled();
  });

  it('returns a non-enumerating not-found error', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'not_found' });
    const result = await server.getHandler('cancel_async_job')!({
      job_id: OBJECT_ID,
      project_id: PROJECT_ID,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.error_type).toBe('not_found');
    expect(result.structuredContent.error.message).not.toContain(OBJECT_ID);
  });

  it('classifies in-flight cancellation as a state conflict without backend detail', async () => {
    mockCallEdge.mockResolvedValueOnce({ data: null, error: 'publishing_in_progress' });
    const result = await server.getHandler('cancel_scheduled_post')!({
      post_id: OBJECT_ID,
      project_id: PROJECT_ID,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.error_type).toBe('validation_error');
    expect(result.content[0].text).not.toContain('publishing_in_progress');
  });
});
