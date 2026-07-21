#!/usr/bin/env node
/**
 * smoke-all-tools.mjs — full-surface MCP smoke + depth harness.
 *
 * Boots the REAL built stdio server (dist/index.js) against a local mock
 * mcp-gateway, then exercises every registered tool over actual JSON-RPC:
 *
 *   initialize → tools/list (verified against tools.lock.json) → tools/call ×N
 *
 * Coverage per tool goes through the same layers a production call does:
 * stdio framing → SDK dispatch → zod input validation → scope enforcement →
 * handler → callEdgeFunction HTTP → response formatting. Only the Supabase
 * backend is mocked (deterministic canned responses; no credits spent).
 *
 * Checks per tool:
 *   - call completes (no protocol error, no crash, no timeout)
 *   - result shape: content[] present with non-empty text
 *   - error hygiene: isError responses carry a clean message
 *   - secret hygiene: API key never appears in any response
 *   - formatting hygiene: no "[object Object]" / "undefined" / "NaN" litter
 *   - backend coverage: which edge functions the tool actually hit
 *
 * Usage:
 *   npm run build:stdio && node scripts/smoke-all-tools.mjs [--include-heavy] [--json out.json] [--md out.md]
 *
 * Heavy local tools (playwright screenshots, Remotion renders) are called
 * with short-circuit args by default; --include-heavy runs them for real.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ARGV = process.argv.slice(2);
const INCLUDE_HEAVY = ARGV.includes('--include-heavy');
// Chaos mode: every gateway call returns bare {success:true} — no payload
// fields. Simulates a backend deploy that changed response shapes. Every tool
// must degrade to a CLEAN error (or an honest empty state), never a raw
// TypeError ("Cannot read properties of undefined") surfaced to the agent.
const CHAOS = ARGV.includes('--chaos');
const argValue = flag => {
  const i = ARGV.indexOf(flag);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : null;
};
const JSON_OUT = argValue('--json');
const MD_OUT = argValue('--md');

// ---------------------------------------------------------------------------
// Fixed identifiers used by the mock backend (stable → deterministic report)
// ---------------------------------------------------------------------------
// Placeholder accepted by the local mock only — derived at runtime so static
// analysis doesn't read it as a hardcoded credential. Never a real key.
const SMOKE_API_KEY = `snk_smoke_harness_${process.pid}_${'0'.repeat(16)}`;
const USER_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const BRAND_ID = '00000000-0000-4000-8000-000000000003';
const PLAN_ID = '00000000-0000-4000-8000-000000000004';
const POST_ID = '00000000-0000-4000-8000-000000000005';
const JOB_ID = '00000000-0000-4000-8000-000000000006';
const CONFIG_ID = '00000000-0000-4000-8000-000000000007';
const APPROVAL_ID = '00000000-0000-4000-8000-000000000008';
const CAROUSEL_ID = '00000000-0000-4000-8000-000000000009';
const DECISION_EVENT_ID = '00000000-0000-4000-8000-00000000000a';
const ACCOUNT_ID = '00000000-0000-4000-8000-00000000000b';
const RUN_ID = '00000000-0000-4000-8000-00000000000c';

// ---------------------------------------------------------------------------
// Mock backend: mcp-auth (key validation) + mcp-gateway (all tool traffic)
// ---------------------------------------------------------------------------

/** gateway call log: [{ tool, functionName, action }] */
const gatewayCalls = [];
let currentTool = '(startup)';

const NOW = new Date().toISOString();

const SAMPLE_POST = {
  id: POST_ID,
  post_id: POST_ID,
  content_id: POST_ID,
  project_id: PROJECT_ID,
  platform: 'youtube',
  title: 'Smoke test post',
  caption: 'Smoke caption #test',
  status: 'published',
  scheduled_at: NOW,
  published_at: NOW,
  created_at: NOW,
  media_type: 'video',
  metrics: { views: 100, likes: 10, comments: 2, shares: 1, engagement_rate: 0.13 },
};

const SAMPLE_PLAN_POST = {
  post_id: POST_ID,
  id: POST_ID,
  platform: 'youtube',
  day: 'monday',
  title: 'Plan post',
  caption: 'Plan caption',
  hook: 'Stop scrolling',
  angle: 'authority',
  hashtags: ['#test'],
  scheduled_time: NOW,
  status: 'draft',
  quality: { total: 30, passed: true },
};

const BRAND_CONTEXT = {
  name: 'Smokebrand',
  brandName: 'Smokebrand',
  description: 'A test brand',
  colors: { primary: '#14B8A6', secondary: '#0F766E', accent: '#F59E0B' },
  voice: { tone: 'confident', style: 'direct', keywords: ['bold'] },
  audience: { primary: 'creators', painPoints: ['time'] },
};

/** One fully-populated async_jobs row (canonical check_status source). */
const SAMPLE_JOB = {
  id: JOB_ID,
  external_id: null,
  job_type: 'video',
  model: 'seedance-2-fast',
  status: 'completed',
  result_url: 'https://media.example.com/video.mp4',
  error_message: null,
  credits_cost: 264,
  credits_reserved: 264,
  credits_charged: 264,
  credits_refunded: 0,
  billing_status: 'charged',
  failure_reason: null,
  created_at: NOW,
  completed_at: NOW,
  result_metadata: {
    all_urls: ['https://media.example.com/video.mp4'],
    model_requested: 'seedance-2-fast',
    model_delivered: 'seedance-2-fast',
    r2_key: 'projects/smoke/video.mp4',
  },
  r2_key: 'projects/smoke/video.mp4',
  project_id: PROJECT_ID,
};

const SAMPLE_COMMENT = {
  id: 'Ugsmoke1',
  videoId: 'dQw4w9WgXcQ',
  videoTitle: 'Smoke video',
  authorDisplayName: 'Viewer',
  authorProfileImageUrl: 'https://example.com/avatar.jpg',
  authorChannelId: 'UCviewer',
  textDisplay: 'Nice video!',
  textOriginal: 'Nice video!',
  likeCount: 3,
  publishedAt: NOW,
  updatedAt: NOW,
  replyCount: 0,
  canReply: true,
  moderationStatus: 'published',
};

const IDEATION_CONTEXT = {
  projectId: PROJECT_ID,
  hasHistoricalData: true,
  promptInjection: 'Top performing hooks: Did you know, Stop doing this, POV.',
  recommendedModel: 'kling-2.0-master',
  recommendedDuration: 30,
  recommendedPostingTime: {
    dayOfWeek: 'monday',
    hourOfDay: 9,
    timezone: 'UTC',
    reasoning: 'Highest engagement window',
  },
  winningPatterns: { hookTypes: ['question'], contentFormats: ['video'], ctaStyles: ['direct'] },
  topHooks: ['Did you know', 'Stop doing this', 'POV'],
  insightsCount: 3,
  generatedAt: NOW,
};

const BRAND_PROFILE_ROW = {
  id: BRAND_ID,
  project_id: PROJECT_ID,
  brand_name: 'Smokebrand',
  brand_context: BRAND_CONTEXT,
  profile_data: {
    colorPalette: ['#14B8A6', '#0F766E', '#F59E0B'],
    typography: { heading: 'Inter', body: 'Inter' },
    voice: { tone: ['confident'], style: ['direct'], keywords: ['bold'] },
    vocabulary: { preferred: ['bold', 'creator'], banned: ['synergy'] },
    messaging: { valueProps: ['ship faster'], pillars: ['education'] },
    claims: [],
  },
  version: 3,
  updated_at: NOW,
  extraction_method: 'url_extract',
  is_active: true,
};

const PLAN_PAYLOAD = {
  plan_id: PLAN_ID,
  topic: 'sustainable fashion for creators',
  generated_at: NOW,
  project_id: PROJECT_ID,
  start_date: NOW.slice(0, 10),
  posts: [SAMPLE_PLAN_POST],
};

/** Stored-row shape returned by mcp-data get-content-plan / auto-approve-plan. */
const SAMPLE_CONTENT_PLAN = {
  id: PLAN_ID,
  plan_id: PLAN_ID,
  project_id: PROJECT_ID,
  topic: 'sustainable fashion for creators',
  status: 'draft',
  plan_payload: PLAN_PAYLOAD,
  insights_applied: null,
  posts: [SAMPLE_PLAN_POST],
  created_at: NOW,
  updated_at: NOW,
};

const SAMPLE_APPROVAL = {
  id: APPROVAL_ID,
  plan_id: PLAN_ID,
  post_id: POST_ID,
  status: 'approved',
  reason: null,
  decided_at: NOW,
  original_post: SAMPLE_PLAN_POST,
  edited_post: null,
  created_at: NOW,
};

const SAMPLE_RECIPE = {
  slug: 'weekly-ig',
  id: 'weekly-ig',
  name: 'Weekly IG Calendar',
  description: 'Plan a week of Instagram content',
  steps: [{ name: 'plan', type: 'tool', tool: 'plan_content_week', description: 'Generate the plan' }],
  inputs_schema: [
    { key: 'topic', label: 'Topic', required: true, type: 'string', description: 'Topic to plan around' },
  ],
  estimated_credits: 50,
  estimated_seconds: 120,
  category: 'planning',
  is_featured: true,
};

const SAMPLE_SKILL = {
  slug: 'tiktok-content',
  kind: 'platform',
  platform: 'tiktok',
  model_id: null,
  tier_minimum: 'free',
  frontmatter: { description: 'How to win on TikTok' },
  updated_at: NOW,
  body_chars: 120,
  locked: false,
  body: '# TikTok playbook\nShort hooks beat long intros.',
  compiled: { whats_working_now: 'Short hooks beat long intros.' },
};

const PLAN_POSTS_JSON = JSON.stringify([
  {
    id: 'post-1',
    day: 1,
    date: NOW.slice(0, 10),
    platform: 'youtube',
    content_type: 'video',
    caption: 'Smoke caption for a planned post #creators',
    title: 'Planned smoke post',
    hashtags: ['#creators'],
    hook: 'Stop scrolling — this changes your workflow',
    angle: 'authority',
    visual_direction: 'Bold teal gradient, centered subject',
    media_type: 'video',
  },
]);

const STORYBOARD_JSON = JSON.stringify({
  title: 'Smoke storyboard',
  totalDuration: 20,
  aspectRatio: '9:16',
  characterDescription: 'Confident creator in a teal hoodie, consistent across all frames',
  frames: [
    {
      id: 'scene-1',
      frameNumber: 1,
      shotType: 'CU',
      cameraMovement: 'static',
      duration: 4,
      imagePrompt: 'Close-up of confident creator in teal hoodie, brand colors',
      videoPrompt: 'Creator looks up at camera, subtle zoom',
      caption: 'Stop scrolling',
      voiceover: 'What if one workflow change saved you an hour a day?',
      notes: 'Pattern interrupt hook',
    },
    {
      id: 'scene-2',
      frameNumber: 2,
      shotType: 'MS',
      cameraMovement: 'zoom-in',
      duration: 4,
      imagePrompt: 'Same creator in teal hoodie at a desk, brand colors',
      videoPrompt: 'Creator gestures at floating UI panels',
      caption: 'One change',
      voiceover: 'Here is the exact setup.',
      notes: 'CTA next',
    },
  ],
});

/** Canned responses per edge function. Function name → (body) => payload. */
const EF_RESPONSES = {
  'mcp-data': body => {
    const action = body?.action ?? '(none)';
    // Branching key only — request data never flows into the response body.
    const base = { success: true };
    switch (action) {
      case 'projects':
        return {
          ...base,
          projects: [
            { id: PROJECT_ID, name: 'Smoke Project', hasConnectedAccounts: true, platforms: ['youtube', 'tiktok'] },
          ],
        };
      case 'brand-profile':
        return { ...base, profile: BRAND_PROFILE_ROW };
      case 'save-brand-profile':
        return { ...base, profileId: BRAND_ID };
      case 'update-platform-voice':
        return { ...base, profileId: BRAND_ID, platform: 'youtube', override: { tone: ['confident'] } };
      case 'connected-accounts':
        return {
          ...base,
          accounts: [
            {
              id: ACCOUNT_ID,
              account_id: ACCOUNT_ID,
              platform: 'youtube',
              platform_username: 'smokechannel',
              username: 'smokechannel',
              status: 'active',
              project_id: PROJECT_ID,
              expires_at: null,
            },
          ],
        };
      case 'recent-posts':
      case 'posts':
        return { ...base, posts: [SAMPLE_POST], total: 1 };
      case 'job-status':
        return { ...base, job: SAMPLE_JOB };
      case 'ideation-context':
        return { ...base, context: IDEATION_CONTEXT };
      case 'loop-summary':
        return {
          ...base,
          summary: {
            brandProfile: { exists: true, version: 3, updatedAt: NOW },
            recentContent: { total: 5, published: 4, scheduled: 1 },
            insights: [{ metric: 'engagement_rate', value: 0.12, trend: 'up' }],
          },
          brandProfile: { exists: true, version: 3, updatedAt: NOW },
          recentContent: { total: 5, published: 4, scheduled: 1 },
          insights: [{ metric: 'engagement_rate', value: 0.12, trend: 'up' }],
        };
      case 'get-content-plan':
        return { ...base, plan: SAMPLE_CONTENT_PLAN, posts: [SAMPLE_PLAN_POST] };
      case 'save-content-plan':
        return { ...base, plan_id: PLAN_ID, planId: PLAN_ID };
      case 'update-content-plan':
        return { ...base, plan: SAMPLE_CONTENT_PLAN, updated: 1, updated_posts: [POST_ID] };
      case 'delete-content-plan':
        return { ...base, deleted: true };
      case 'submit-plan-approval':
      case 'submit-content-plan-for-approval':
        return { ...base, plan: { ...SAMPLE_CONTENT_PLAN, status: 'in_review' }, approvalsCreated: 1, created: 1 };
      case 'create-plan-approvals':
        return { ...base, created: 1, items: [{ ...SAMPLE_APPROVAL, status: 'pending' }] };
      case 'list-plan-approvals':
        // Approved so schedule_content_plan's approval gate passes in the
        // happy path (the gate itself is proven by the chaos run).
        return {
          ...base,
          items: [SAMPLE_APPROVAL],
          approvals: [SAMPLE_APPROVAL],
          total: 1,
        };
      case 'respond-plan-approval':
        return { ...base, approval: SAMPLE_APPROVAL };
      case 'auto-approve-plan':
        return {
          ...base,
          plan: SAMPLE_CONTENT_PLAN,
          approved: 1,
          flagged: 0,
          results: [{ post_id: POST_ID, decision: 'approved', score: 30 }],
          summary: { approved: 1, flagged: 0, total: 1 },
        };
      case 'create-autopilot-config':
        return { ...base, created: { id: CONFIG_ID, name: 'Smoke autopilot' } };
      case 'pipeline-readiness':
        return {
          ...base,
          credits: 1200,
          is_unlimited: false,
          connected_platforms: ['youtube', 'tiktok'],
          missing_platforms: [],
          has_brand: true,
          pending_approvals: 0,
          insight_age: 2,
          insights_fresh: true,
        };
      case 'run-pipeline':
        return {
          ...base,
          // budget-check phase reads credits/is_unlimited; later phases read run state.
          credits: 1200,
          is_unlimited: false,
          run_id: RUN_ID,
          runId: RUN_ID,
          status: 'completed',
          stages: [
            { name: 'research', status: 'completed' },
            { name: 'plan', status: 'completed' },
            { name: 'quality', status: 'completed' },
          ],
          plan: SAMPLE_CONTENT_PLAN,
          plan_id: PLAN_ID,
          dry_run: true,
        };
      case 'pipeline-status':
        return {
          ...base,
          run: {
            id: RUN_ID,
            status: 'completed',
            stages: [{ name: 'research', status: 'completed' }],
            pending_approvals: 0,
            scheduled_posts: 1,
          },
        };
      case 'mint-connection-nonce':
        return {
          ...base,
          nonce: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          platform: 'youtube',
          project_id: PROJECT_ID,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          deep_link: 'https://socialneuron.com/connect?nonce=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        };
      case 'connection-status':
        return { ...base, status: 'active', account: { id: ACCOUNT_ID, platform: 'youtube', status: 'active' } };
      case 'get-recipes':
      case 'list-recipes':
        return { ...base, recipes: [SAMPLE_RECIPE], total: 1 };
      case 'get-recipe-details':
        return { ...base, recipe: SAMPLE_RECIPE, ...SAMPLE_RECIPE };
      case 'execute-recipe':
        return { ...base, run_id: RUN_ID, runId: RUN_ID, status: 'pending', message: 'queued' };
      case 'get-recipe-run-status':
        return {
          ...base,
          run: {
            id: RUN_ID,
            recipe_slug: 'weekly-ig',
            status: 'completed',
            current_step: 1,
            total_steps: 1,
            credits_used: 50,
            outputs: { plan_id: PLAN_ID },
            started_at: NOW,
            completed_at: NOW,
          },
        };
      case 'get-skills':
        return { ...base, skills: [SAMPLE_SKILL] };
      case 'get-skill':
        return { ...base, skill: SAMPLE_SKILL };
      case 'run-skill':
        return {
          ...base,
          run_preview: { steps: 9, credits: 580, deep_link: 'https://socialneuron.com/runs/smoke' },
          run_id: RUN_ID,
        };
      case 'find-winning-content':
        return {
          ...base,
          winners: [
            {
              id: 'w1',
              title: 'Winning short',
              platform: 'tiktok',
              views: 2000000,
              hook_pattern: 'pattern interrupt',
              structure: 'hook→proof→cta',
              replication_prompt: 'Make a video that opens on a pattern interrupt...',
              qa_gated: true,
            },
          ],
          filters: {},
          count: 1,
        };
      case 'suggest-next-content':
        return {
          ...base,
          suggestions: [{ topic: 'Behind the scenes', reason: 'High engagement', score: 0.8 }],
        };
      default:
        return {
          ...base,
          // Superset of common list/detail keys so unmodelled actions still
          // exercise the tool's happy formatting path instead of erroring.
          posts: [SAMPLE_POST],
          items: [],
          accounts: [],
          projects: [{ id: PROJECT_ID, name: 'Smoke Project', hasConnectedAccounts: true, platforms: ['youtube'] }],
          profile: null,
          data: {},
          _mock_default_action: true,
        };
    }
  },

  // --- generation (dedicated EFs) -------------------------------------------
  'kie-video-generate': () => ({
    success: true,
    taskId: 'kie-task-1',
    asyncJobId: JOB_ID,
    jobId: JOB_ID,
    job_id: JOB_ID,
    status: 'queued',
    creditsReserved: 264,
    credits_reserved: 264,
    creditsUsed: 264,
  }),
  'kie-image-generate': () => ({
    success: true,
    taskId: 'kie-task-2',
    asyncJobId: JOB_ID,
    jobId: JOB_ID,
    job_id: JOB_ID,
    status: 'queued',
    creditsReserved: 20,
    credits_reserved: 20,
    creditsUsed: 20,
  }),
  'kie-task-status': () => ({
    success: true,
    status: 'completed',
    progress: 100,
    resultUrl: 'https://media.example.com/video.mp4',
    jobId: JOB_ID,
  }),
  'elevenlabs-tts': () => ({
    success: true,
    audioUrl: 'https://media.example.com/audio.mp3',
    r2Key: 'projects/smoke/audio.mp3',
    durationSeconds: 12,
    creditsUsed: 5,
  }),
  'social-neuron-ai': body => {
    if (body?.type === 'storyboard') {
      return { success: true, content: STORYBOARD_JSON, model: 'gemini-2.5-flash' };
    }
    if (body?.responseFormat === 'json') {
      return { success: true, text: PLAN_POSTS_JSON, content: PLAN_POSTS_JSON };
    }
    return {
      success: true,
      text: 'Generated smoke content body with a strong hook and clear CTA.',
      content: 'Generated smoke content body with a strong hook and clear CTA.',
    };
  },
  'cancel-async-job': () => ({
    success: true,
    status: 'cancelled',
    billing_status: 'refunded',
    credits_refunded: 264,
  }),
  'upload-to-r2': () => ({
    success: true,
    url: 'https://media.example.com/upload.png',
    key: 'projects/smoke/upload.png',
    size: 1024,
    contentType: 'image/png',
  }),
  'get-signed-url': () => ({
    success: true,
    // Resolvable public host: schedule_post SSRF-validates (DNS-resolves) the
    // signed URL before publishing, so a fake hostname would be blocked.
    signedUrl: 'https://example.com/signed.png',
    url: 'https://example.com/signed.png',
    key: 'projects/smoke/upload.png',
    expiresIn: 3600,
  }),
  'fetch-url-content': () => ({
    success: true,
    data: {
      title: 'Example article',
      description: 'Example description',
      content: 'Extracted body text about creator workflows.',
      text: 'Extracted body text about creator workflows.',
      features: ['fast'],
      benefits: ['saves time'],
      usp: 'The fastest workflow',
    },
  }),
  'scrape-youtube': () => ({
    success: true,
    data: {
      title: 'Smoke video',
      description: 'desc',
      viewCount: 1000,
      likes: 100,
      tags: ['smoke'],
      channelName: 'Smoke Channel',
      duration: 60,
      segments: [{ text: 'hello world' }],
      segmentCount: 1,
    },
  }),

  // --- brand ---------------------------------------------------------------
  'brand-extract': () => ({ ...BRAND_CONTEXT, logoUrl: 'https://example.com/logo.png' }),

  // --- analytics / insights -------------------------------------------------
  'fetch-analytics': () => ({ success: true, posts: [SAMPLE_POST], metrics: SAMPLE_POST.metrics, total: 1 }),
  'refresh-analytics': () => ({ success: true, queued: 1, jobs: [{ id: JOB_ID, platform: 'youtube' }] }),
  'youtube-analytics': () => ({
    success: true,
    channel: { id: 'UCsmoke', title: 'Smoke Channel', views: 1000, subscribers: 100 },
    rows: [],
    videos: [],
    columnHeaders: [],
  }),
  'performance-insights': () => ({
    success: true,
    insights: [
      { metric: 'engagement_rate', value: 0.12, trend: 'up', period: '30d', platform: 'youtube' },
    ],
    summary: 'Engagement is trending up.',
  }),

  // --- distribution ---------------------------------------------------------
  'schedule-post': () => ({
    success: true,
    post: SAMPLE_POST,
    postId: POST_ID,
    post_id: POST_ID,
    scheduled_at: NOW,
    results: [{ platform: 'youtube', status: 'scheduled', post_id: POST_ID }],
  }),
  'schedule-content-plan': () => ({
    success: true,
    scheduled: 1,
    skipped: 0,
    results: [{ post_id: POST_ID, platform: 'youtube', status: 'scheduled', scheduled_at: NOW }],
  }),
  'reschedule-post': () => ({
    success: true,
    post_id: POST_ID,
    previous_scheduled_at: NOW,
    scheduled_at: new Date(Date.now() + 172_800_000).toISOString(),
  }),
  'cancel-scheduled-post': () => ({ success: true, status: 'cancelled', post_id: POST_ID }),

  // --- carousel -------------------------------------------------------------
  'generate-carousel': () => ({
    success: true,
    carousel: {
      id: CAROUSEL_ID,
      slides: [{ slideNumber: 1, headline: 'Slide 1', body: 'Body', accentWord: 'Slide' }],
    },
    slides: [{ slideNumber: 1, headline: 'Slide 1', body: 'Body', accentWord: 'Slide' }],
    creditsUsed: 3,
  }),
  'create-carousel': () => ({
    success: true,
    carouselId: CAROUSEL_ID,
    carousel_id: CAROUSEL_ID,
    slides: [{ slideNumber: 1, headline: 'Slide 1', imageJobId: JOB_ID }],
    imageJobs: [{ slide: 1, jobId: JOB_ID, job_id: JOB_ID, status: 'queued' }],
    creditsReserved: 30,
  }),
  'delete-carousel': () => ({ success: true, deleted: true }),

  // --- comments -------------------------------------------------------------
  'youtube-comments': body => {
    const action = body?.action ?? 'list';
    if (action === 'list') return { success: true, comments: [SAMPLE_COMMENT], nextPageToken: null };
    if (action === 'reply' || action === 'post') {
      return { success: true, comment: { id: 'Ugsmoke2', textDisplay: 'Thanks for watching!' } };
    }
    if (action === 'moderate') return { success: true, status: 'published', comment_id: 'Ugsmoke1' };
    if (action === 'delete') return { success: true, deleted: true, comment_id: 'Ugsmoke1' };
    return { success: true, comments: [SAMPLE_COMMENT] };
  },

  // --- autopilot ------------------------------------------------------------
  autopilot: body => {
    const action = body?.action ?? '(none)';
    const config = {
      id: CONFIG_ID,
      config_id: CONFIG_ID,
      project_id: PROJECT_ID,
      name: 'Smoke autopilot',
      enabled: true,
      is_active: true,
      mode: 'suggest',
      schedule_days: ['monday'],
      schedule_time: '09:00',
      posts_per_week: 3,
      credit_budget: 500,
      max_credits_per_run: 200,
      approval_mode: 'manual',
      last_run_at: NOW,
      next_run_at: NOW,
      created_at: NOW,
    };
    switch (action) {
      case 'list':
        return { success: true, configs: [config], total: 1 };
      case 'status':
        return {
          success: true,
          activeConfigs: 1,
          active_configs: 1,
          recentRuns: [{ id: RUN_ID, status: 'completed', credits_used: 50, at: NOW }],
          recent_runs: [{ id: RUN_ID, status: 'completed', credits_used: 50, at: NOW }],
          creditsConsumed: 50,
          credits_consumed: 50,
          nextRunAt: NOW,
          next_run_at: NOW,
        };
      case 'create':
        return { success: true, created: { id: CONFIG_ID }, config, configId: CONFIG_ID };
      case 'update':
        return { success: true, config, updated: true };
      case 'delete':
        return { success: true, deleted: true };
      default:
        return { success: true, configs: [config], config, configId: CONFIG_ID, created: { id: CONFIG_ID } };
    }
  },

  // --- credits / usage ------------------------------------------------------
  'credit-balance': () => ({
    success: true,
    balance: 1200,
    credits: 1200,
    monthlyLimit: 1500,
    monthly_limit: 1500,
    spendingCap: 3750,
    plan: 'pro',
    tier: 'pro',
  }),
  'mcp-usage': () => ({
    success: true,
    month: NOW.slice(0, 7),
    totalCalls: 42,
    total_calls: 42,
    creditsUsed: 300,
    credits_used: 300,
    byTool: [{ tool: 'generate_content', calls: 10, credits: 10 }],
    tools: [{ tool: 'generate_content', calls: 10, credits: 10 }],
  }),

  // --- loop / learning ------------------------------------------------------
  'mc-bandit-state': () => ({
    project_id: PROJECT_ID,
    platform_filter: null,
    arm_type_filter: null,
    top_k: 5,
    groups: [
      {
        arm_type: 'hook_family',
        platform_scoped: [
          {
            arm_type: 'hook_family',
            arm_name: 'question',
            platform: 'tiktok',
            alpha: 8,
            beta: 4,
            total_pulls: 12,
            total_reward: 7.2,
            last_pulled_at: NOW,
            updated_at: NOW,
            posterior_mean: 0.667,
            posterior_variance: 0.017,
            posterior_stdev: 0.13,
          },
        ],
        platform_agnostic: [],
        summary: 'question leads on tiktok',
      },
    ],
    total_arms: 1,
    generated_at: NOW,
  }),
  'mc-loop-pulse': () => ({
    pulse: { stage: 'analyze', health: 'green' },
    kpis: [
      {
        metric: 'reflection_coverage',
        label: 'Reflection coverage',
        value: 82,
        unit: '%',
        status: 'ok',
        why: 'Share of published posts with a written agent reflection.',
      },
      {
        metric: 'visual_gate_pass',
        label: 'Visual gate pass rate',
        value: 64,
        unit: '%',
        status: 'warn',
        why: 'Share of rendered slides passing the visual QA gate first try.',
      },
    ],
    overall: 'ok',
    generated_at: NOW,
  }),
  'write-agent-reflection': () => ({ success: true, reflection_id: DECISION_EVENT_ID }),
  'read-agent-reflection': () => ({
    reflections: [
      {
        id: DECISION_EVENT_ID,
        reflection_text: 'Shorts with strong hooks outperformed.',
        generated_by_agent: 'analyst',
        provenance_jsonb: {},
        created_at: NOW,
      },
    ],
  }),
  'record-outcome': () => ({ id: DECISION_EVENT_ID, idempotent: false }),

  // --- hermes (drafts / lessons / observations / campaigns) -----------------
  hermes: () => ({
    success: true,
    id: DECISION_EVENT_ID,
    draft_id: DECISION_EVENT_ID,
    lesson_id: DECISION_EVENT_ID,
    observation_id: DECISION_EVENT_ID,
    signal_id: DECISION_EVENT_ID,
    spend_id: DECISION_EVENT_ID,
    campaigns: [
      { id: RUN_ID, name: 'Smoke campaign', status: 'active', budget: 100, spent: 25, started_at: NOW },
    ],
  }),

  // --- ideation extras ------------------------------------------------------
  'fetch-trends': () => ({
    success: true,
    trends: [{ title: 'Trending topic', source: 'youtube', views: 100000, url: 'https://example.com/t' }],
    cached: false,
  }),
  'adapt-content': () => ({ success: true, content: 'Adapted content', adapted: 'Adapted content', creditsUsed: 1 }),
  'ideation-context': () => ({
    success: true,
    context: 'Recent winners: strong hooks. Audience: creators.',
    sources: { insights: 1, posts: 5 },
  }),
  'niche-research': () => ({
    success: true,
    winners: [
      {
        id: 'w1',
        title: 'Winning short',
        platform: 'tiktok',
        views: 2000000,
        hook_pattern: 'pattern interrupt',
        structure: 'hook→proof→cta',
        replication_prompt: 'Make a video that...',
        qa_gated: true,
      },
    ],
  }),
  'suggest-next-content': () => ({
    success: true,
    suggestions: [{ topic: 'Behind the scenes', reason: 'High engagement', score: 0.8 }],
  }),
  'detect-anomalies': () => ({
    success: true,
    anomalies: [{ type: 'spike', metric: 'views', change: 3.2, post_id: POST_ID, detected_at: NOW }],
    period: '7d',
  }),
  'performance-digest': () => ({
    success: true,
    digest: {
      period: '7d',
      totals: { views: 1000, likes: 100 },
      trends: { views: '+20%' },
      top: [SAMPLE_POST],
      bottom: [],
      recommendations: ['Double down on shorts'],
    },
  }),
  'best-posting-times': () => ({
    success: true,
    slots: [{ day: 'monday', hour: 9, score: 0.9, avg_engagement: 0.12 }],
  }),
  'find-next-slots': () => ({
    success: true,
    slots: [{ at: NOW, score: 0.9, platform: 'youtube' }],
  }),

  // --- quality --------------------------------------------------------------
  'quality-check': () => ({
    success: true,
    scores: {
      hook_strength: 4,
      message_clarity: 5,
      platform_fit: 4,
      brand_alignment: 5,
      novelty: 4,
      cta_strength: 4,
      safety_claims: 5,
    },
    total: 31,
    passed: true,
    threshold: 26,
    feedback: ['Strong hook'],
  }),

  // --- recipes / skills -----------------------------------------------------
  recipes: body => {
    const action = body?.action ?? '(none)';
    const recipe = {
      id: 'weekly-instagram-calendar',
      recipe_id: 'weekly-instagram-calendar',
      name: 'Weekly Instagram Calendar',
      description: 'Plan a week of IG content',
      steps: [{ name: 'plan', tool: 'plan_content_week' }],
      inputs: { topic: { type: 'string', required: true } },
      estimated_credits: 50,
    };
    switch (action) {
      case 'list':
        return { success: true, recipes: [recipe], total: 1 };
      case 'details':
      case 'get':
        return { success: true, recipe };
      case 'execute':
        return { success: true, runId: RUN_ID, run_id: RUN_ID, status: 'running' };
      case 'run-status':
      case 'status':
        return {
          success: true,
          run: { id: RUN_ID, status: 'completed', current_step: 1, total_steps: 1, credits_used: 50, outputs: {} },
        };
      default:
        return { success: true, recipes: [recipe], recipe, runId: RUN_ID };
    }
  },
  skills: body => {
    const action = body?.action ?? '(none)';
    const skill = {
      id: 'skill-brand-locked-viral-hook-reel',
      slug: 'skill-brand-locked-viral-hook-reel',
      name: 'Brand-locked viral hook reel',
      studio: 'video',
      category: 'hook',
      shortDescription: 'Brand-locked 12s reel',
      body: '# Playbook\nHook in 0.5s...',
      compiled: { whats_working_now: 'Strong hooks' },
      estimatedCredits: 580,
      stepCount: 9,
    };
    switch (action) {
      case 'list':
        return { success: true, skills: [skill], total: 1 };
      case 'get':
        return { success: true, skill };
      case 'run':
        return {
          success: true,
          run_preview: { steps: 9, credits: 580, deep_link: 'https://socialneuron.com/runs/smoke' },
          runId: RUN_ID,
        };
      default:
        return { success: true, skills: [skill], skill, runId: RUN_ID };
    }
  },

  // --- extraction / knowledge ----------------------------------------------
  'extract-url-content': () => ({
    success: true,
    type: 'article',
    title: 'Example article',
    content: 'Extracted body text',
    text: 'Extracted body text',
    metadata: { url: 'https://example.com/a' },
  }),
  'knowledge-search': () => ({
    success: true,
    results: [{ id: 'doc-1', title: 'MCP quickstart', url: 'https://socialneuron.com/docs/mcp' }],
  }),
  'knowledge-fetch': () => ({
    success: true,
    id: 'doc-1',
    title: 'MCP quickstart',
    text: 'Doc body',
    url: 'https://socialneuron.com/docs/mcp',
  }),

  // --- storyboard / templates ----------------------------------------------
  'create-storyboard': () => ({
    success: true,
    storyboard: {
      id: RUN_ID,
      frames: [
        {
          index: 0,
          prompt: 'Opening shot',
          duration: 3,
          caption: 'Open',
          voiceover: 'Welcome',
        },
      ],
      characterDescription: 'Consistent smoke avatar',
    },
    creditsUsed: 10,
  }),
  'render-template-video': () => ({ success: true, jobId: JOB_ID, job_id: JOB_ID, status: 'queued' }),

  // --- platform connections -------------------------------------------------
  'platform-connect': () => ({
    success: true,
    url: 'https://socialneuron.com/connect/smoke-token',
    deep_link: 'https://socialneuron.com/connect/smoke-token',
    expires_in: 600,
  }),
  'connection-status': () => ({
    success: true,
    status: 'active',
    account: { id: ACCOUNT_ID, platform: 'youtube', status: 'active' },
  }),

  // --- upload session -------------------------------------------------------
  'request-upload-session': () => ({
    success: true,
    upload_url: 'https://socialneuron.com/upload/smoke-token',
    token: 'smoke-upload-token',
    expires_in: 900,
  }),
};

function mockGatewayResponse(functionName, body) {
  if (CHAOS) return { success: true };
  const handler = EF_RESPONSES[functionName];
  if (handler) return handler(body);
  // Default: generic success. Logged so unmodelled functions are visible.
  return { success: true, _mock_default: true };
}

function startMockBackend() {
  return new Promise(resolveStart => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        const send = obj => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        try {
          const url = new URL(req.url, 'http://localhost');
          if (url.pathname === '/functions/v1/mcp-auth') {
            send({
              valid: true,
              userId: USER_ID,
              scopes: ['mcp:full'],
              email: 'smoke@harness.local',
              expiresAt: null,
              projectId: PROJECT_ID,
            });
            return;
          }
          if (url.pathname === '/functions/v1/mcp-gateway') {
            const parsed = raw ? JSON.parse(raw) : {};
            // Allowlist-sanitize request-derived identifiers before they are
            // stored (and later logged/reported): slug charset only.
            const functionName =
              typeof parsed.functionName === 'string' && /^[\w.-]{1,64}$/.test(parsed.functionName)
                ? parsed.functionName
                : '(unknown)';
            const body = parsed.body ?? {};
            const action =
              typeof body.action === 'string' && /^[\w.-]{1,64}$/.test(body.action)
                ? body.action
                : null;
            gatewayCalls.push({ tool: currentTool, functionName, action });
            send(mockGatewayResponse(functionName, body));
            return;
          }
          // Static bodies and static logs only: request data and error
          // details never flow into responses OR log lines (keeps the mock
          // trivially clean of reflected-XSS and log-injection patterns).
          // Unmatched paths surface as auth/tool failures in the report.
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{"error":"not_found"}');
        } catch {
          console.error('[mock-backend] request handler threw; returning 500');
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"mock_backend_error"}');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolveStart(server));
  });
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio client (newline-delimited JSON-RPC)
// ---------------------------------------------------------------------------

class McpStdioClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.exited = null;
    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    child.stderr.on('data', chunk => {
      this.stderr += chunk.toString('utf8');
    });
    child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      for (const [, { resolve }] of this.pending) {
        resolve({ error: { code: -1, message: `server exited (code=${code} signal=${signal})` } });
      }
      this.pending.clear();
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ error: { code: -2, message: `timeout after ${timeoutMs}ms` }, _timeout: true });
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: msg => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      this.child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }
}

// ---------------------------------------------------------------------------
// Argument synthesis from JSON Schema + per-tool overrides
// ---------------------------------------------------------------------------

/** Values keyed by parameter name — wins over type-based synthesis. */
const PARAM_VALUES = {
  project_id: PROJECT_ID,
  brand_id: BRAND_ID,
  plan_id: PLAN_ID,
  post_id: POST_ID,
  job_id: JOB_ID,
  config_id: CONFIG_ID,
  approval_id: APPROVAL_ID,
  carousel_id: CAROUSEL_ID,
  decision_event_id: DECISION_EVENT_ID,
  account_id: ACCOUNT_ID,
  run_id: RUN_ID,
  content_id: POST_ID,
  video_id: 'dQw4w9WgXcQ',
  comment_id: 'Ugsmoke1',
  parent_id: 'Ugsmoke1',
  url: 'https://example.com',
  source_url: 'https://example.com',
  platform: 'youtube',
  platforms: ['youtube'],
  topic: 'sustainable fashion for creators',
  content: 'Smoke test content body with a strong hook and a clear call to action.',
  text: 'Smoke test text',
  caption: 'Smoke caption #test',
  title: 'Smoke title',
  prompt: 'A teal neuron logo floating over a calm gradient background',
  r2_key: 'projects/smoke/video.mp4',
};

/** Per-tool argument overrides (merged over synthesized args). */
const TOOL_ARGS = {
  // discovery / knowledge — fetch's id is filled at runtime from search results
  search_tools: { query: 'brand', detail: 'summary' },
  search: { query: 'mcp' },

  // ideation
  generate_content: { content_type: 'caption', platform: 'youtube', topic: PARAM_VALUES.topic },
  fetch_trends: { source: 'youtube' },
  adapt_content: { content: PARAM_VALUES.content, target_platform: 'tiktok' },

  // media
  generate_video: { prompt: PARAM_VALUES.prompt, model: 'grok-imagine' },
  generate_image: { prompt: PARAM_VALUES.prompt },
  generate_voiceover: { text: 'Welcome to the smoke test.' },
  upload_media: {
    file_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    file_name: 'smoke.png',
  },
  get_media_url: { r2_key: 'projects/smoke/video.mp4' },
  check_status: { job_id: JOB_ID },
  cancel_async_job: { job_id: JOB_ID },

  // brand
  extract_brand: { url: 'https://example.com' },
  save_brand_profile: { brand_context: { name: 'Smokebrand', voice: { tone: 'confident' } } },
  update_platform_voice: { platform: 'youtube', tone: ['confident'] },
  check_brand_consistency: { content: PARAM_VALUES.content },
  audit_brand_colors: { content_colors: ['#14B8A6', '#FF0000'] },
  export_design_tokens: { format: 'css' },

  // planning
  plan_content_week: { topic: PARAM_VALUES.topic },
  save_content_plan: {
    plan: {
      topic: PARAM_VALUES.topic,
      posts: [
        {
          platform: 'youtube',
          day: 1,
          date: NOW.slice(0, 10),
          title: 'Plan post',
          caption: 'Plan caption',
          hook: 'Stop scrolling',
          angle: 'authority',
          content_type: 'caption',
        },
      ],
    },
  },
  update_content_plan: {
    plan_id: PLAN_ID,
    post_updates: [{ post_id: POST_ID, caption: 'Updated caption' }],
  },
  respond_plan_approval: { approval_id: APPROVAL_ID, decision: 'approved' },
  auto_approve_plan: { plan_id: PLAN_ID },

  // quality
  quality_check: { content: PARAM_VALUES.content, platform: 'youtube' },
  quality_check_plan: { plan_id: PLAN_ID },
  visual_quality_check: {
    slides: [
      { slideNumber: 1, type: 'title', headline: 'Short headline', body: 'Body text' },
      { slideNumber: 2, type: 'body', headline: 'Second slide', body: 'More body text' },
    ],
  },

  // distribution — r2_key is the canonical agent path (generate → check_status
  // → r2_key → schedule_post); avoids external media-URL DNS in the harness.
  schedule_post: {
    platforms: ['youtube'],
    caption: 'Smoke caption',
    title: 'Smoke title',
    r2_key: 'projects/smoke/video.mp4',
    schedule_at: new Date(Date.now() + 86_400_000).toISOString(),
    platform_metadata: { youtube: { title: 'Smoke title' } },
  },
  reschedule_post: {
    post_id: POST_ID,
    scheduled_at: new Date(Date.now() + 172_800_000).toISOString(),
  },
  schedule_content_plan: { plan_id: PLAN_ID, dry_run: true },
  start_platform_connection: { platform: 'youtube' },
  wait_for_connection: { platform: 'youtube', timeout_s: 5, poll_interval_s: 2 },

  // comments
  reply_to_comment: { parent_id: 'Ugsmoke1', text: 'Thanks for watching!' },
  post_comment: { video_id: 'dQw4w9WgXcQ', text: 'New episode is live.' },
  moderate_comment: { comment_id: 'Ugsmoke1', status: 'published' },
  delete_comment: { comment_id: 'Ugsmoke1' },

  // autopilot — create relies on schema synthesis for required enums/fields
  update_autopilot_config: { config_id: CONFIG_ID, enabled: false },
  delete_autopilot_config: { config_id: CONFIG_ID },

  // pipeline
  run_content_pipeline: { topic: PARAM_VALUES.topic, dry_run: true },
  get_pipeline_status: { run_id: RUN_ID },

  // recipes / skills
  get_recipe_details: { slug: 'weekly-ig' },
  execute_recipe: { slug: 'weekly-ig', inputs: { topic: PARAM_VALUES.topic } },
  get_recipe_run_status: { run_id: RUN_ID },
  get_skill: { slug: 'tiktok-content' },
  run_skill: { skill_id: 'skill-brand-locked-viral-hook-reel' },

  // loop / learning
  write_agent_reflection: {
    reflection_text: 'Smoke reflection: strong hooks continue to win.',
    generated_by_agent: 'analyst',
    provenance: {},
    brand_id: BRAND_ID,
  },
  record_outcome: { decision_event_id: DECISION_EVENT_ID, horizon: '24h', reward: 0.7 },
  read_agent_reflection: { brand_id: BRAND_ID },

  // hermes
  save_draft_to_library: { content: PARAM_VALUES.content, platform: 'youtube' },
  record_voice_lesson: { lesson: 'Short punchy openers outperform.', source: 'analytics' },
  record_observation: { observation: 'Competitor pivoted to carousels.' },
  record_intel_signal: { signal: 'Trend: silent vlogs', source_url: 'https://example.com' },
  record_campaign_spend: { campaign_id: RUN_ID, amount: 25, currency: 'USD' },

  // storyboard
  create_storyboard: { topic: PARAM_VALUES.topic, scene_count: 2 },

  // remotion / hyperframes — probe args (fast failure paths) unless --include-heavy
  render_demo_video: { composition_id: 'nonexistent-smoke-comp' },
  render_hyperframes: {
    html: '<html><body><script>window.__hf={duration:0.1,seek:()=>{}}</script></body></html>',
    duration_seconds: 0.1,
  },
  render_template_video: { template_id: 'smoke-template', props: {} },

  // screenshots — SSRF-negative probe for capture_screenshot (localhost must be
  // blocked); capture_app_page requires test creds and should fail cleanly.
  capture_screenshot: { url: 'http://127.0.0.1:1/smoke' },
  capture_app_page: { page: 'dashboard' },

  // youtube analytics
  fetch_youtube_analytics: {
    report: 'channel',
    start_date: '2026-07-01',
    end_date: '2026-07-14',
  },
};

/**
 * Tools whose SUCCESS is an isError:true response for the args we send
 * (negative probes / environment-dependent local tools).
 */
const ERROR_OK = new Set([
  'capture_screenshot', // localhost URL must be SSRF-blocked → clean tool error
  'capture_app_page', // no TEST_LOGIN creds in harness env → clean tool error
  'render_demo_video', // nonexistent composition → clean tool error
  'render_hyperframes', // headless render may be unavailable in CI → either ok or clean error
  'render_template_video', // unknown template may be rejected → either ok or clean error
]);

/** Heavy tools get a longer leash. */
const SLOW_TOOLS = new Set([
  'render_demo_video',
  'render_hyperframes',
  'capture_screenshot',
  'capture_app_page',
  'list_compositions',
]);

function synthesizeFromSchema(schema, paramName) {
  if (!schema || typeof schema !== 'object') return 'smoke';
  // Destructive tools require a literal `confirm: true` acknowledgement.
  if (paramName === 'confirm') return true;
  if (paramName && PARAM_VALUES[paramName] !== undefined) return PARAM_VALUES[paramName];
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'string': {
      if (schema.format === 'uuid') return PROJECT_ID;
      if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com';
      if (schema.format === 'date-time') return NOW;
      const min = schema.minLength ?? 1;
      let v = 'smoke test value';
      while (v.length < min) v += ' smoke';
      if (schema.maxLength && v.length > schema.maxLength) v = v.slice(0, schema.maxLength);
      return v;
    }
    case 'number':
    case 'integer': {
      let v = schema.minimum ?? schema.exclusiveMinimum ?? 1;
      if (schema.exclusiveMinimum !== undefined && v === schema.exclusiveMinimum) v += 1;
      if (schema.maximum !== undefined && v > schema.maximum) v = schema.maximum;
      return v;
    }
    case 'boolean':
      return false;
    case 'array': {
      const item = synthesizeFromSchema(schema.items ?? { type: 'string' }, null);
      const minItems = schema.minItems ?? 1;
      return Array.from({ length: Math.max(1, minItems) }, () => item);
    }
    case 'object': {
      const out = {};
      const required = schema.required ?? [];
      for (const key of required) {
        out[key] = synthesizeFromSchema(schema.properties?.[key], key);
      }
      return out;
    }
    default:
      if (schema.anyOf?.length) return synthesizeFromSchema(schema.anyOf[0], paramName);
      if (schema.oneOf?.length) return synthesizeFromSchema(schema.oneOf[0], paramName);
      return 'smoke';
  }
}

function buildArgs(tool) {
  const args = {};
  const schema = tool.inputSchema ?? {};
  const required = schema.required ?? [];
  for (const name of required) {
    args[name] = synthesizeFromSchema(schema.properties?.[name], name);
  }
  const overrides = TOOL_ARGS[tool.name];
  if (overrides) Object.assign(args, overrides);
  return args;
}

// ---------------------------------------------------------------------------
// Response inspection
// ---------------------------------------------------------------------------

const SLOPPY_PATTERNS = [
  /\[object Object\]/,
  /\bundefined\b(?! behavior)/,
  /\bNaN\b/,
];

/** Raw JS runtime errors that must never reach an agent-facing message. */
const RUNTIME_ERROR_PATTERNS =
  /Cannot read propert|is not iterable|is not a function|Cannot destructure|Cannot convert undefined|of undefined|of null/;

function inspectResult(toolName, rpc, expectErrorOk) {
  const finding = {
    tool: toolName,
    classification: 'ok',
    isError: false,
    notes: [],
    excerpt: '',
    gatewayFunctions: [],
  };

  if (rpc._timeout) {
    finding.classification = 'timeout';
    finding.notes.push(rpc.error.message);
    return finding;
  }
  if (rpc.error) {
    finding.classification = 'protocol_error';
    finding.notes.push(`JSON-RPC error ${rpc.error.code}: ${rpc.error.message}`);
    return finding;
  }

  const result = rpc.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map(c => (typeof c?.text === 'string' ? c.text : ''))
    .join('\n')
    .trim();
  finding.excerpt = text.slice(0, 300);
  finding.isError = result.isError === true;

  if (content.length === 0) {
    finding.classification = 'bad_shape';
    finding.notes.push('result.content missing or empty');
    return finding;
  }
  if (!text) {
    finding.classification = 'bad_shape';
    finding.notes.push('all content items empty');
    return finding;
  }

  if (text.includes(SMOKE_API_KEY)) {
    finding.classification = 'secret_leak';
    finding.notes.push('response contains the raw API key');
    return finding;
  }

  for (const pattern of SLOPPY_PATTERNS) {
    if (pattern.test(text)) {
      finding.notes.push(`sloppy formatting: ${pattern}`);
    }
  }

  // A raw JS runtime error in an agent-facing message means a handler crashed
  // on an unexpected backend shape instead of degrading cleanly.
  if (RUNTIME_ERROR_PATTERNS.test(text)) {
    finding.classification = 'robustness_bug';
    finding.notes.push('raw JS runtime error surfaced to the agent');
    return finding;
  }

  if (finding.isError) {
    finding.classification = expectErrorOk ? 'error_expected' : 'tool_error';
  }
  return finding;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const lock = JSON.parse(readFileSync(resolve(ROOT, 'tools.lock.json'), 'utf8'));
  const lockNames = new Set(Object.keys(lock.tools));

  const backend = await startMockBackend();
  const { port } = backend.address();
  const backendUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [resolve(ROOT, 'dist/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      SOCIALNEURON_API_KEY: SMOKE_API_KEY,
      SOCIALNEURON_SUPABASE_URL: backendUrl,
      SUPABASE_ANON_KEY: `smoke-anon-${process.pid}`,
      DO_NOT_TRACK: '1',
      // Never inherit real credentials/service keys into the harness run.
      SOCIALNEURON_SERVICE_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new McpStdioClient(child);

  const startupTimeout = 30_000;
  const init = await client.request(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke-all-tools', version: '1.0.0' },
    },
    startupTimeout
  );
  if (init.error) {
    console.error('FATAL: initialize failed:', JSON.stringify(init.error));
    console.error('--- server stderr ---\n' + client.stderr);
    process.exit(2);
  }
  client.notify('notifications/initialized', {});

  const listed = await client.request('tools/list', {}, 30_000);
  if (listed.error) {
    console.error('FATAL: tools/list failed:', JSON.stringify(listed.error));
    process.exit(2);
  }
  const tools = listed.result.tools ?? [];
  const runtimeNames = new Set(tools.map(t => t.name));

  // Surface verification vs lock (stdio profile: hosted-only apps absent)
  const HOSTED_ONLY = new Set(['open_content_calendar', 'open_analytics_pulse']);
  const missing = [...lockNames].filter(n => !runtimeNames.has(n) && !HOSTED_ONLY.has(n));
  const unexpected = [...runtimeNames].filter(n => !lockNames.has(n));

  console.log(`tools/list returned ${tools.length} tools (lock: ${lockNames.size}, hosted-only excluded: ${HOSTED_ONLY.size})`);
  if (missing.length) console.log(`MISSING vs lock: ${missing.join(', ')}`);
  if (unexpected.length) console.log(`UNEXPECTED vs lock: ${unexpected.join(', ')}`);

  // Pre-fetch a real knowledge-doc id so the `fetch` probe exercises the
  // happy path (ids are internal to the local catalog).
  let knowledgeDocId = null;
  try {
    const searchRpc = await client.request(
      'tools/call',
      { name: 'search', arguments: { query: 'mcp' } },
      15_000
    );
    const text = searchRpc.result?.content?.[0]?.text ?? '';
    knowledgeDocId = JSON.parse(text)?.results?.[0]?.id ?? null;
  } catch {
    // fetch probe falls back to a not-found negative probe
  }

  // In chaos mode a clean tool_error IS the desired degradation — only raw
  // runtime errors / crashes / timeouts / protocol faults count as failures.
  const passClasses = CHAOS
    ? new Set(['ok', 'error_expected', 'tool_error'])
    : new Set(['ok', 'error_expected']);

  const findings = [];
  let index = 0;
  for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
    index += 1;
    currentTool = tool.name;
    const callStart = gatewayCalls.length;
    const args = buildArgs(tool);
    if (tool.name === 'fetch') {
      args.id = knowledgeDocId ?? 'smoke-missing-doc';
    }
    const timeout = SLOW_TOOLS.has(tool.name) ? (INCLUDE_HEAVY ? 180_000 : 60_000) : 30_000;
    const rpc = await client.request('tools/call', { name: tool.name, arguments: args }, timeout);
    const finding = inspectResult(tool.name, rpc, ERROR_OK.has(tool.name));
    finding.args = args;
    finding.gatewayFunctions = [
      ...new Set(
        gatewayCalls
          .slice(callStart)
          .map(c => (c.action ? `${c.functionName}:${c.action}` : c.functionName))
      ),
    ];
    findings.push(finding);
    const mark = passClasses.has(finding.classification) ? 'PASS' : 'FAIL';
    console.log(
      `[${String(index).padStart(3)}/${tools.length}] ${mark} ${tool.name} → ${finding.classification}` +
        (finding.notes.length ? ` (${finding.notes.join('; ')})` : '')
    );
    if (client.exited) {
      console.error(`FATAL: server exited mid-run after ${tool.name}`);
      findings.push({ tool: '(server)', classification: 'crash', notes: [JSON.stringify(client.exited)] });
      break;
    }
  }

  currentTool = '(shutdown)';
  child.kill('SIGTERM');
  backend.close();

  // -------------------------------------------------------------------------
  // Summarize
  // -------------------------------------------------------------------------
  const byClass = {};
  for (const f of findings) byClass[f.classification] = (byClass[f.classification] ?? 0) + 1;

  const failures = findings.filter(f => !passClasses.has(f.classification));
  const sloppy = findings.filter(f => f.notes.some(n => n.startsWith('sloppy')));
  const defaultMocked = findings.filter(f =>
    f.gatewayFunctions.some(fn => {
      const bare = fn.split(':')[0];
      return !(bare in EF_RESPONSES);
    })
  );
  const noNetwork = findings.filter(f => f.gatewayFunctions.length === 0 && !f.notes.length);

  const summary = {
    generated_at: NOW,
    server_version: init.result?.serverInfo?.version ?? '(unknown)',
    tool_count_listed: tools.length,
    lock_count: lockNames.size,
    surface_missing_vs_lock: missing,
    surface_unexpected_vs_lock: unexpected,
    classifications: byClass,
    failures: failures.map(f => ({ tool: f.tool, classification: f.classification, notes: f.notes, excerpt: f.excerpt })),
    sloppy_formatting: sloppy.map(f => ({ tool: f.tool, notes: f.notes.filter(n => n.startsWith('sloppy')) })),
    local_only_tools: noNetwork.map(f => f.tool),
    unmodelled_edge_functions: [
      ...new Set(
        gatewayCalls
          .map(c => c.functionName)
          .filter(fn => !(fn in EF_RESPONSES))
      ),
    ],
    findings,
  };

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ ...summary, findings: undefined }, null, 2));

  if (JSON_OUT) {
    mkdirSync(dirname(resolve(JSON_OUT)), { recursive: true });
    writeFileSync(resolve(JSON_OUT), JSON.stringify(summary, null, 2));
    console.log(`\nJSON report → ${JSON_OUT}`);
  }
  if (MD_OUT) {
    mkdirSync(dirname(resolve(MD_OUT)), { recursive: true });
    writeFileSync(resolve(MD_OUT), renderMarkdown(summary));
    console.log(`Markdown report → ${MD_OUT}`);
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

function renderMarkdown(summary) {
  const lines = [];
  lines.push(`# MCP tool smoke report — ${summary.generated_at.slice(0, 10)}`);
  lines.push('');
  lines.push(`Server version: ${summary.server_version} · Tools listed: ${summary.tool_count_listed} (lock: ${summary.lock_count})`);
  lines.push('');
  lines.push('## Classification counts');
  lines.push('');
  lines.push('| Classification | Count |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(summary.classifications)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  if (summary.surface_missing_vs_lock.length || summary.surface_unexpected_vs_lock.length) {
    lines.push('## Surface drift vs tools.lock.json');
    lines.push('');
    if (summary.surface_missing_vs_lock.length)
      lines.push(`Missing: ${summary.surface_missing_vs_lock.join(', ')}`);
    if (summary.surface_unexpected_vs_lock.length)
      lines.push(`Unexpected: ${summary.surface_unexpected_vs_lock.join(', ')}`);
    lines.push('');
  }
  if (summary.failures.length) {
    lines.push('## Failures');
    lines.push('');
    for (const f of summary.failures) {
      lines.push(`### ${f.tool} — ${f.classification}`);
      lines.push('');
      for (const n of f.notes) lines.push(`- ${n}`);
      if (f.excerpt) {
        lines.push('');
        lines.push('```');
        lines.push(f.excerpt);
        lines.push('```');
      }
      lines.push('');
    }
  } else {
    lines.push('## Failures');
    lines.push('');
    lines.push('None. 🎉');
    lines.push('');
  }
  if (summary.sloppy_formatting.length) {
    lines.push('## Sloppy formatting notes');
    lines.push('');
    for (const f of summary.sloppy_formatting) lines.push(`- ${f.tool}: ${f.notes.join('; ')}`);
    lines.push('');
  }
  lines.push('## Per-tool results');
  lines.push('');
  lines.push('| Tool | Result | Backend functions hit |');
  lines.push('|---|---|---|');
  for (const f of summary.findings ?? []) {
    lines.push(`| ${f.tool} | ${f.classification} | ${f.gatewayFunctions?.join(', ') || '(none)'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

main().catch(err => {
  console.error('harness crashed:', err);
  process.exit(2);
});
