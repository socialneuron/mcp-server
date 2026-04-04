import { callEdgeFunction } from '../../lib/edge-function.js';
import { initializeAuth, getDefaultUserId } from '../../lib/supabase.js';
import { emitSnResult, classifySupabaseCliError, tryGetSupabaseClient } from './parse.js';
import type { SnArgs } from './types.js';

async function ensureAuth(): Promise<string> {
  await initializeAuth();
  return getDefaultUserId();
}

export async function handleStatus(args: SnArgs, asJson: boolean): Promise<void> {
  const jobId = args['job-id'];
  if (typeof jobId !== 'string') {
    throw new Error('Missing required flag: --job-id');
  }

  // Auth after flag validation
  const userId = await ensureAuth();
  const supabase = tryGetSupabaseClient();
  let job: any = null;

  if (supabase) {
    const { data: byId, error: byIdError } = await supabase
      .from('async_jobs')
      .select(
        'id, external_id, status, job_type, model, result_url, error_message, created_at, completed_at'
      )
      .eq('user_id', userId)
      .eq('id', jobId)
      .maybeSingle();

    if (byIdError) {
      const formatted = classifySupabaseCliError('fetch job status', byIdError);
      throw new Error(formatted.message);
    }

    if (byId) {
      job = byId;
    } else {
      const { data: byExternal, error: byExternalError } = await supabase
        .from('async_jobs')
        .select(
          'id, external_id, status, job_type, model, result_url, error_message, created_at, completed_at'
        )
        .eq('user_id', userId)
        .eq('external_id', jobId)
        .maybeSingle();
      if (byExternalError) {
        const formatted = classifySupabaseCliError('fetch job status', byExternalError);
        throw new Error(formatted.message);
      }
      job = byExternal;
    }
  } else {
    const { data, error } = await callEdgeFunction<{
      success: boolean;
      job?: any;
      error?: string;
    }>('mcp-data', {
      action: 'job-status',
      userId,
      jobId,
    });

    if (error || !data?.success) {
      throw new Error(`Failed to fetch job status: ${error ?? data?.error ?? 'Unknown error'}`);
    }

    job = data.job ?? null;
  }

  if (!job) {
    throw new Error(`No job found with ID "${jobId}".`);
  }

  if (asJson) {
    emitSnResult({ ok: true, command: 'status', job }, true);
  } else {
    console.error(`Job: ${job.id}`);
    console.error(`Status: ${job.status}`);
    console.error(`Type: ${job.job_type}`);
    console.error(`Model: ${job.model}`);
    if (job.result_url) console.error(`Result URL: ${job.result_url}`);
    if (job.error_message) console.error(`Error: ${job.error_message}`);
    console.error(`Created: ${job.created_at}`);
    if (job.completed_at) console.error(`Completed: ${job.completed_at}`);
  }
  process.exit(0);
}

export async function handleAutopilot(args: SnArgs, asJson: boolean): Promise<void> {
  const userId = await ensureAuth();
  const supabase = tryGetSupabaseClient();

  let activeConfigs: number;
  let pendingApprovals: number;
  let configs: Array<Record<string, unknown>>;

  if (supabase) {
    const [configsResult, approvalsResult] = await Promise.all([
      supabase
        .from('autopilot_configs')
        .select('id, platform, is_enabled, schedule_config, updated_at')
        .eq('user_id', userId)
        .eq('is_enabled', true),
      supabase.from('approval_queue').select('id').eq('user_id', userId).eq('status', 'pending'),
    ]);

    activeConfigs = configsResult.data?.length ?? 0;
    pendingApprovals = approvalsResult.data?.length ?? 0;
    configs = configsResult.data ?? [];
  } else {
    // Cloud mode: route through mcp-gateway
    const { data, error } = await callEdgeFunction<{
      success: boolean;
      activeConfigs: number;
      pendingApprovals: number;
      configs: Array<Record<string, unknown>>;
      error?: string;
    }>('mcp-data', { action: 'autopilot-status', userId });

    if (error || !data?.success) {
      throw new Error(`Autopilot status failed: ${error ?? data?.error ?? 'Unknown error'}`);
    }

    activeConfigs = data.activeConfigs;
    pendingApprovals = data.pendingApprovals;
    configs = data.configs ?? [];
  }

  if (asJson) {
    emitSnResult(
      { ok: true, command: 'autopilot', activeConfigs, pendingApprovals, configs },
      true
    );
  } else {
    console.error('Autopilot Status');
    console.error('================');
    console.error(`Active Configs: ${activeConfigs}`);
    console.error(`Pending Approvals: ${pendingApprovals}`);
    if (configs.length) {
      console.error('\nConfigs:');
      for (const cfg of configs) {
        console.error(`- ${cfg.platform}: enabled (updated ${cfg.updated_at})`);
      }
    }
  }
  process.exit(0);
}

export async function handleUsage(args: SnArgs, asJson: boolean): Promise<void> {
  const userId = await ensureAuth();
  const supabase = tryGetSupabaseClient();

  type ToolUsage = { tool_name: string; call_count: number; credits_total: number };
  let totalCalls: number;
  let totalCredits: number;
  let tools: ToolUsage[];

  if (supabase) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: rows, error: rpcError } = await supabase.rpc('get_mcp_monthly_usage', {
      p_user_id: userId,
      p_since: startOfMonth.toISOString(),
    });

    if (rpcError) {
      // Fallback: query activity_logs directly
      const { data: logs } = await supabase
        .from('activity_logs')
        .select('action, metadata')
        .eq('user_id', userId)
        .gte('created_at', startOfMonth.toISOString())
        .like('action', 'mcp:%');

      totalCalls = logs?.length ?? 0;
      totalCredits = 0;
      tools = [];
    } else {
      tools = (rows ?? []) as ToolUsage[];
      totalCalls = tools.reduce((sum: number, t) => sum + (t.call_count ?? 0), 0);
      totalCredits = tools.reduce((sum: number, t) => sum + (t.credits_total ?? 0), 0);
    }
  } else {
    // Cloud mode: route through mcp-gateway
    const { data, error } = await callEdgeFunction<{
      success: boolean;
      totalCalls: number;
      totalCredits: number;
      tools: ToolUsage[];
      error?: string;
    }>('mcp-data', { action: 'mcp-usage', userId });

    if (error || !data?.success) {
      throw new Error(`Usage fetch failed: ${error ?? data?.error ?? 'Unknown error'}`);
    }

    totalCalls = data.totalCalls;
    totalCredits = data.totalCredits;
    tools = data.tools ?? [];
  }

  if (asJson) {
    emitSnResult({ ok: true, command: 'usage', totalCalls, totalCredits, tools }, true);
  } else {
    console.error('MCP Usage This Month');
    console.error('====================');
    console.error(`Total Calls: ${totalCalls}`);
    console.error(`Total Credits: ${totalCredits}`);
    if (tools.length) {
      console.error('\nPer-Tool Breakdown:');
      for (const tool of tools) {
        console.error(
          `- ${tool.tool_name}: ${tool.call_count} calls, ${tool.credits_total} credits`
        );
      }
    }
  }
  process.exit(0);
}

export async function handleCredits(args: SnArgs, asJson: boolean): Promise<void> {
  const userId = await ensureAuth();
  const supabase = tryGetSupabaseClient();

  let balance: number;
  let monthlyUsed: number;
  let monthlyLimit: number;
  let plan: string;

  if (supabase) {
    // Self-host mode: query DB directly
    const [profileResult, subResult] = await Promise.all([
      supabase
        .from('user_profiles')
        .select('credits, monthly_credits_used')
        .eq('id', userId)
        .maybeSingle(),
      supabase
        .from('subscriptions')
        .select('tier, status, monthly_credits')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (profileResult.error) throw profileResult.error;

    balance = Number(profileResult.data?.credits || 0);
    monthlyUsed = Number(profileResult.data?.monthly_credits_used || 0);
    monthlyLimit = Number(subResult.data?.monthly_credits || 0);
    plan = (subResult.data?.tier as string) || 'free';
  } else {
    // Cloud mode: route through mcp-gateway
    const { data, error } = await callEdgeFunction<{
      success: boolean;
      balance: number;
      monthlyUsed: number;
      monthlyLimit: number;
      plan: string;
      error?: string;
    }>('mcp-data', { action: 'credit-balance', userId });

    if (error || !data?.success) {
      throw new Error(`Credit balance failed: ${error ?? data?.error ?? 'Unknown error'}`);
    }

    balance = data.balance;
    monthlyUsed = data.monthlyUsed;
    monthlyLimit = data.monthlyLimit;
    plan = data.plan;
  }

  if (asJson) {
    emitSnResult({ ok: true, command: 'credits', balance, monthlyUsed, monthlyLimit, plan }, true);
  } else {
    console.error('Credit Balance');
    console.error('==============');
    console.error(`Plan: ${plan.toUpperCase()}`);
    console.error(`Balance: ${balance} credits`);
    if (monthlyLimit) {
      console.error(`Monthly Usage: ${monthlyUsed} / ${monthlyLimit}`);
    }
  }
  process.exit(0);
}
