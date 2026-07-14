# Lifecycle and Billing Backend Smoke Test

This is the production acceptance gate for [issue #186](https://github.com/socialneuron/mcp-server/issues/186) and [issue #187](https://github.com/socialneuron/mcp-server/issues/187). Passing unit tests or merging the MCP projection is necessary but not sufficient: both issues stay open until the compatible private `mcp-data` backend is deployed and the authenticated hosted service produces the evidence below.

## Safety and prerequisites

- Use dedicated test users, projects, platform connections, and disposable artifacts. Never use a customer's object ID for a negative authorization test.
- Record the hosted MCP version and commit from `/health`, the public tool count from `/.well-known/mcp/server-card.json`, and the deployed private backend commit before testing.
- Capture redacted request and response JSON. Do not record API keys, OAuth tokens, signed media URLs, raw provider errors, or customer content.
- Record credit balances before and after every billed test. Set a written test-credit ceiling before starting generation.
- Run destructive tools only with `confirm: true`, after separately recording the created disposable object and its expected project owner.

## Issue #186: ownership-scoped cleanup

Use two dedicated test identities: user A owns projects A1 and A2; user B owns project B1. Create one disposable artifact of each supported type through the normal API or app workflow, then exercise the hosted MCP or REST projection.

| Probe | Expected evidence |
| --- | --- |
| Omit `confirm` or send `false` | Schema validation rejects the call before mutation. |
| User A deletes an A1 carousel, content plan, or autopilot configuration with the matching `project_id` | `success: true`, `deleted: true`, the expected identifier is returned, and a read confirms the row is gone. |
| User A supplies the A2 `project_id` for an A1 artifact | A non-enumerating `not_found`; the A1 row remains. |
| User B supplies an A1 artifact ID from its B1 project | A non-enumerating `not_found`; the A1 row remains. |
| Repeat a successful delete | `not_found`; no unrelated row changes. |
| Cancel an A1 draft, pending, or scheduled post before worker claim | `cancelled: true`; the post and its pending schedule job are terminal and no platform publication occurs. |
| Attempt cancellation after the publication worker has claimed the post | A conflict/validation error such as `publishing_in_progress`; the service must not claim cancellation succeeded. |
| Cancel a pending owned async job | `cancelled: true` plus an explicit `refunded_credits`/`refund_status` result; a repeat cannot issue a second refund. |

Do not close #186 until every ownership boundary above is proven on the deployed service. Metadata-only carousel deletion intentionally leaves media to the retention process, and content-plan deletion intentionally does not cancel posts previously scheduled from the plan; verify and document both behaviors rather than treating them as leaks.

## Issue #187: structured failed-job billing

Produce a real asynchronous job failure in a controlled test project. Prefer an approved provider-failure fixture or a naturally failed test job; do not send abusive or policy-violating content merely to force failure.

Poll the real job with `check_status` until terminal, and retain this redacted contract:

```json
{
  "status": "failed",
  "credits_reserved": 0,
  "credits_charged": 0,
  "credits_refunded": 0,
  "billing_status": "failed_no_charge",
  "failure_reason": "generation_failed"
}
```

The exact amounts may differ. The valid terminal outcomes are:

- `failed_no_charge`: `credits_charged` and `credits_refunded` are both zero;
- `refunded`: charged and refunded amounts reconcile, and the account balance confirms the refund;
- `refund_pending`: the response is honest but the test fails release acceptance until operations reconcile the refund and the subsequent status becomes `refunded`.

Also verify that:

- the reported amounts reconcile with the before/after credit balance and ledger;
- `credits_reserved` remains zero unless a real reservation ledger exists—quoted cost is not reservation evidence;
- `error_message` and `failure_reason` contain stable public wording only, with no provider payload, database name, stack trace, storage key, token, or signed URL;
- a successful job reports `charged` or `not_charged` consistently with the ledger;
- carousel per-item failures carry the same structured billing contract;
- an unknown job ID returns non-enumerating `not_found` behavior and no billing metadata.

Do not close #187 using a mocked response, a local unit test, or a job created before the compatible backend deployment.

## Evidence record

Attach one redacted evidence comment to each issue containing:

```text
Tested at (UTC):
Hosted MCP version / commit:
Private backend commit:
Authenticated client and transport:
Test account aliases (no email or user UUID):
Project aliases (no customer UUID):
Probe matrix: PASS / FAIL with redacted response artifact links
Credit ceiling / actual credits spent:
Operator:
Independent reviewer:
```

Close an issue only after its full matrix passes, the evidence comment is attached, and an independent reviewer agrees that the responses came from the deployed authenticated service.
