# Lifecycle Backend Smoke Checklist

PR #195 adds the public MCP forwarding layer for lifecycle cleanup tools. Do not close #186 or mark the lifecycle audit complete until the deployed `mcp-data` backend supports and smoke-tests every action below.

| Public MCP tool | Backend edge action | Required deployed-backend proof |
|---|---|---|
| `cancel_async_job` | `cancel-async-job` | A queued or processing media/render job owned by the caller is marked canceled, no completion worker continues it, and billing is refunded or reported as no-charge. |
| `delete_carousel` | `delete-carousel` | A carousel draft owned by the caller is removed or archived, related persisted metadata is no longer returned, and another caller cannot delete it. |
| `cancel_scheduled_post` | `cancel-scheduled-post` | A scheduled post owned by the caller is unscheduled before publication, platform dispatch is prevented, and another caller cannot cancel it. |
| `delete_content_plan` | `delete-content-plan` | A persisted content plan owned by the caller and its draft approval rows are removed or archived, and another caller cannot delete them. |
| `delete_autopilot_config` | `delete-autopilot-config` | An autopilot configuration owned by the caller is disabled or removed, future runs stop, and another caller cannot delete it. |

Minimum release smoke run:

1. Use a non-production test project with a caller API key that has the needed MCP scopes.
2. Create or select one owned fixture for each row in the table.
3. Invoke the public MCP tool through the hosted MCP endpoint or REST tool proxy, not only a local mocked `callEdgeFunction` test.
4. Confirm the tool returns success and the underlying database state changed as expected.
5. Repeat one negative authorization check per action with another user or project and confirm the fixture is not modified.

Related audit issues:

- #186 stays open until all five lifecycle actions pass this deployed-backend smoke run.
- #187 stays open until failed async jobs report explicit billing fields from the backend, or the fallback is verified against a real failed job.
- #188 can close from the public MCP side once the structured `isError` metadata has shipped.
