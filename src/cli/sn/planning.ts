import { callEdgeFunction } from '../../lib/edge-function.js';
import { initializeAuth, getDefaultUserId } from '../../lib/supabase.js';
import { emitSnResult } from './parse.js';
import type { SnArgs } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContentPlan {
  id: string;
  status: string;
  created_at: string;
  title?: string;
  summary?: string;
  plan_payload?: Record<string, unknown>;
}

interface PlanListResponse {
  success: boolean;
  plans: ContentPlan[];
}

interface PlanDetailResponse {
  success: boolean;
  plan: ContentPlan;
}

interface PlanApprovalResponse {
  success: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureAuth(): Promise<string> {
  await initializeAuth();
  return getDefaultUserId();
}

const PLAN_USAGE = `Usage: sn plan <subcommand> [flags]

Subcommands:
  list      List content plans
  view      View a single content plan
  approve   Approve a content plan

Flags:
  list:
    --status <draft|submitted|approved>   Filter by status (optional)

  view:
    --plan-id <id>                        Plan ID (required)

  approve:
    --plan-id <id>                        Plan ID (required)
`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function handlePlanList(args: SnArgs, asJson: boolean): Promise<void> {
  const status = typeof args.status === 'string' ? args.status : undefined;

  const userId = await ensureAuth();

  const body: Record<string, unknown> = { action: 'list-content-plans', userId };
  if (status) {
    body.status = status;
  }

  const { data, error } = await callEdgeFunction<PlanListResponse>('mcp-data', body);

  if (error || !data) {
    throw new Error(`Failed to list plans: ${error ?? 'Unknown error'}`);
  }

  const plans = data.plans ?? [];

  if (asJson) {
    emitSnResult({ ok: true, command: 'plan list', plans }, true);
  } else {
    if (plans.length === 0) {
      console.error('No content plans found.');
    } else {
      console.error('plan-id | status | created_at | title');
      console.error('--------|--------|------------|------');
      for (const p of plans) {
        const title = p.title ?? p.summary ?? '(untitled)';
        console.error(`${p.id} | ${p.status} | ${p.created_at} | ${title}`);
      }
    }
  }
}

async function handlePlanView(args: SnArgs, asJson: boolean): Promise<void> {
  const planId = args['plan-id'];
  if (typeof planId !== 'string') {
    throw new Error('Missing required flag: --plan-id');
  }

  const userId = await ensureAuth();

  const { data, error } = await callEdgeFunction<PlanDetailResponse>('mcp-data', {
    action: 'get-content-plan',
    userId,
    planId,
  });

  if (error || !data) {
    throw new Error(`Failed to view plan: ${error ?? 'Unknown error'}`);
  }

  const plan = data.plan;

  if (asJson) {
    emitSnResult({ ok: true, command: 'plan view', plan }, true);
  } else {
    const title = plan.title ?? plan.summary ?? '(untitled)';
    console.error(`Plan: ${plan.id}`);
    console.error(`Title: ${title}`);
    console.error(`Status: ${plan.status}`);
    console.error(`Created: ${plan.created_at}`);
    if (plan.plan_payload) {
      console.error(`Payload: ${JSON.stringify(plan.plan_payload, null, 2)}`);
    }
  }
}

async function handlePlanApprove(args: SnArgs, asJson: boolean): Promise<void> {
  const planId = args['plan-id'];
  if (typeof planId !== 'string') {
    throw new Error('Missing required flag: --plan-id');
  }

  const userId = await ensureAuth();

  const { data, error } = await callEdgeFunction<PlanApprovalResponse>('mcp-data', {
    action: 'respond-plan-approval',
    userId,
    planId,
    response: 'approved',
  });

  if (error || !data) {
    throw new Error(`Failed to approve plan: ${error ?? 'Unknown error'}`);
  }

  if (asJson) {
    emitSnResult(
      {
        ok: data.success,
        command: 'plan approve',
        planId,
        message: data.message ?? 'Plan approved',
      },
      true
    );
  } else {
    console.error(`Plan ${planId}: ${data.success ? 'Approved' : 'Failed'}`);
    if (data.message) {
      console.error(data.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handlePlan(args: SnArgs, asJson: boolean): Promise<void> {
  const subcommand = args._[0];

  if (!subcommand || args.help === true) {
    console.error(PLAN_USAGE);
    return;
  }

  switch (subcommand) {
    case 'list':
      return handlePlanList({ ...args, _: args._.slice(1) }, asJson);
    case 'view':
      return handlePlanView({ ...args, _: args._.slice(1) }, asJson);
    case 'approve':
      return handlePlanApprove({ ...args, _: args._.slice(1) }, asJson);
    default:
      throw new Error(`Unknown plan subcommand: '${subcommand}'. Run 'sn plan --help' for usage.`);
  }
}
