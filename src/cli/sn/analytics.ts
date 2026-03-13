import { callEdgeFunction } from '../../lib/edge-function.js';
import { initializeAuth, getDefaultUserId, getSupabaseClient } from '../../lib/supabase.js';
import { emitSnResult, classifySupabaseCliError, tryGetSupabaseClient } from './parse.js';
import type { SnArgs } from './types.js';

async function ensureAuth(): Promise<string> {
  await initializeAuth();
  return getDefaultUserId();
}

export async function handlePosts(args: SnArgs, asJson: boolean): Promise<void> {
  const userId = await ensureAuth();
  const supabase = tryGetSupabaseClient();
  const daysRaw = args.days;
  const days = typeof daysRaw === 'string' ? Number(daysRaw) : 7;
  const lookbackDays = Number.isFinite(days) && days > 0 ? Math.min(days, 90) : 7;

  const since = new Date();
  since.setDate(since.getDate() - lookbackDays);

  let posts: any[] = [];

  if (supabase) {
    let query = supabase
      .from('posts')
      .select(
        'id, platform, status, title, external_post_id, scheduled_at, published_at, created_at'
      )
      .eq('user_id', userId)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(50);

    if (typeof args.platform === 'string') {
      query = query.eq('platform', args.platform);
    }
    if (typeof args.status === 'string') {
      query = query.eq('status', args.status);
    }

    const { data, error } = await query;
    if (error) {
      const formatted = classifySupabaseCliError('fetch posts', error);
      throw new Error(formatted.message);
    }

    posts = data ?? [];
  } else {
    const { data, error } = await callEdgeFunction<{ success: boolean; posts: any[] }>('mcp-data', {
      action: 'recent-posts',
      userId,
      days: lookbackDays,
      limit: 50,
      platform: typeof args.platform === 'string' ? args.platform : undefined,
      status: typeof args.status === 'string' ? args.status : undefined,
    });

    if (error || !data?.success) {
      throw new Error('Failed to fetch posts: ' + (error ?? 'Unknown error'));
    }

    posts = data.posts ?? [];
  }

  if (!posts || posts.length === 0) {
    if (asJson) {
      emitSnResult({ ok: true, command: 'posts', posts: [] }, true);
    } else {
      console.error('No posts found.');
    }
    process.exit(0);
  }

  if (asJson) {
    emitSnResult({ ok: true, command: 'posts', posts }, true);
  } else {
    for (const post of posts) {
      console.error(
        `${post.created_at} | ${post.platform} | ${post.status} | ${post.title ?? '(untitled)'} | ${post.id}`
      );
    }
  }
  process.exit(0);
}

export async function handleRefreshAnalytics(args: SnArgs, asJson: boolean): Promise<void> {
  await ensureAuth();
  const { data, error } = await callEdgeFunction<{ success: boolean; postsProcessed: number }>(
    'fetch-analytics',
    {}
  );
  if (error || !data?.success) {
    throw new Error(`Analytics refresh failed: ${error ?? 'Unknown error'}`);
  }
  if (asJson) {
    emitSnResult(
      { ok: true, command: 'refresh-analytics', postsProcessed: data.postsProcessed },
      true
    );
  } else {
    console.error(`Analytics refresh queued for ${data.postsProcessed} post(s).`);
  }
  process.exit(0);
}

export async function handleLoop(args: SnArgs, asJson: boolean): Promise<void> {
  const userId = await ensureAuth();
  try {
    const supabase = getSupabaseClient();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [brandResult, contentResult, insightsResult] = await Promise.all([
      supabase
        .from('brand_profiles')
        .select('id')
        .eq('user_id', userId)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle(),
      supabase
        .from('content_history')
        .select('id, content_type, created_at')
        .eq('user_id', userId)
        .gte('created_at', thirtyDaysAgo.toISOString())
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('performance_insights')
        .select('id, insight_type, generated_at')
        .gte('generated_at', thirtyDaysAgo.toISOString())
        .gt('expires_at', new Date().toISOString())
        .limit(20),
    ]);

    const hasProfile = !!brandResult.data;
    const recentCount = contentResult.data?.length ?? 0;
    const insightsCount = insightsResult.data?.length ?? 0;

    let nextAction = 'Generate content to start building your feedback loop';
    if (!hasProfile) nextAction = 'Set up your brand profile first';
    else if (recentCount === 0)
      nextAction = 'Generate and publish content to collect performance data';
    else if (insightsCount === 0)
      nextAction = 'Publish more content — insights need 5+ data points';
    else nextAction = 'Loop is active — use insights to improve next content batch';

    if (asJson) {
      emitSnResult(
        {
          ok: true,
          command: 'loop',
          brandStatus: { hasProfile },
          recentContent: contentResult.data ?? [],
          currentInsights: insightsResult.data ?? [],
          recommendedNextAction: nextAction,
        },
        true
      );
    } else {
      console.error('Feedback Loop Summary');
      console.error('=====================');
      console.error(`Brand Profile: ${hasProfile ? 'Ready' : 'Missing'}`);
      console.error(`Recent Content: ${recentCount} items (last 30 days)`);
      console.error(`Current Insights: ${insightsCount} active`);
      console.error(`\nNext Action: ${nextAction}`);
    }
  } catch (err) {
    throw new Error(`Loop summary failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}
