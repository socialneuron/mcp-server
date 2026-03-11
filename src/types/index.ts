// ============================================================================
// Shared types for the Social Neuron MCP server
// ============================================================================

/** Platforms supported for distribution and trend fetching. */
export type Platform =
  | 'youtube'
  | 'tiktok'
  | 'instagram'
  | 'twitter'
  | 'linkedin'
  | 'facebook'
  | 'threads'
  | 'bluesky';

/** Content types the AI generation endpoint supports. */
export type ContentType = 'script' | 'caption' | 'blog' | 'hook' | 'generation';

/** Video generation model identifiers (matches kie-video-generate MODEL_CONFIG). */
export type VideoModel =
  | 'veo3-fast'
  | 'veo3-quality'
  | 'runway-aleph'
  | 'sora2'
  | 'sora2-pro'
  | 'kling'
  | 'luma'
  | 'midjourney-video';

/** Image generation model identifiers (matches kie-image-generate MODEL_CONFIG). */
export type ImageModel =
  | 'midjourney'
  | 'nano-banana'
  | 'nano-banana-pro'
  | 'ideogram'
  | 'flux-pro'
  | 'flux-max'
  | 'gpt4o-image'
  | 'imagen4'
  | 'imagen4-fast'
  | 'seedream';

/** Aspect ratios supported by generation endpoints. */
export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4';

/** Trend data sources supported by fetch-trends. */
export type TrendSource = 'youtube' | 'google_trends' | 'rss' | 'url';

/** Async job status values (mirrors async_jobs.status column). */
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

// ============================================================================
// Edge Function response shapes
// ============================================================================

export interface GenerateContentResponse {
  text: string;
}

export interface GenerateVideoResponse {
  taskId: string;
  asyncJobId: string | null;
  status: string;
  model: string;
  estimatedTime: number;
  creditsDeducted: number;
}

export interface GenerateImageResponse {
  taskId: string;
  asyncJobId: string | null;
  status: string;
  model: string;
}

export interface JobStatusResponse {
  taskId: string;
  status: JobStatus;
  progress: number;
  resultUrl: string | null;
  allImageUrls: string[] | null;
  creditsUsed: number | null;
  error: string | null;
}

export interface TrendItem {
  title: string;
  description?: string;
  url?: string;
  views?: string | number;
  publishedAt?: string;
  source: string;
  category?: string;
  thumbnail?: string;
}

export interface FetchTrendsResponse {
  trends: TrendItem[];
  source: string;
  category: string;
  cached: boolean;
  expiresAt?: string;
  count?: number;
}

export interface BrandProfile {
  brandName: string;
  description: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
  };
  voice: {
    tone: string;
    style: string;
    keywords: string[];
  };
  audience: {
    primary: string;
    painPoints: string[];
  };
  logoUrl: string | null;
}

export interface PlatformVoiceOverride {
  tone?: string[];
  style?: string[];
  sampleContent?: string;
  hashtagStrategy?: string;
  ctaStyle?: string;
  avoidPatterns?: string[];
}

export interface IdeationContext {
  projectId: string | null;
  hasHistoricalData: boolean;
  promptInjection: string;
  recommendedModel: string;
  recommendedDuration: number;
  recommendedPostingTime?: {
    dayOfWeek: number;
    hourOfDay: number;
    timezone?: string;
    reasoning?: string;
  };
  winningPatterns: {
    hookTypes: string[];
    contentFormats: string[];
    ctaStyles: string[];
  };
  topHooks: string[];
  insightsCount: number;
  generatedAt?: string;
}

export interface ResponseEnvelope<T> {
  _meta: {
    version: string;
    timestamp: string;
  };
  data: T;
}

export interface SchedulePostResult {
  success: boolean;
  results: Record<string, { success: boolean; jobId?: string; postId?: string; error?: string }>;
  scheduledAt: string;
}

export interface ConnectedAccount {
  id: string;
  platform: string;
  status: string;
  username: string | null;
  created_at: string;
}

export interface AnalyticsSummary {
  platform: string | null;
  totalViews: number;
  totalEngagement: number;
  totalClicks: number;
  postCount: number;
  posts: AnalyticsPost[];
}

export interface AnalyticsPost {
  id: string;
  platform: string;
  title: string | null;
  views: number;
  engagement: number;
  clicks: number;
  posted_at: string;
  content_type?: string | null;
  model_used?: string | null;
}

export interface PerformanceInsight {
  id: string;
  project_id: string;
  insight_type: string;
  insight_data: Record<string, unknown>;
  confidence_score: number | null;
  generated_at: string;
}

export interface PostRecord {
  id: string;
  platform: string;
  status: string;
  title: string | null;
  external_post_id: string | null;
  published_at: string | null;
  scheduled_at: string | null;
  created_at: string;
}

export interface BestPostingTime {
  platform: string;
  day_of_week: number;
  hour: number;
  avg_engagement: number;
  sample_size: number;
}

// ============================================================================
// YouTube Analytics types
// ============================================================================

export interface YouTubeChannelAnalytics {
  views: number;
  watchTimeMinutes: number;
  subscribersGained: number;
  subscribersLost: number;
  likes: number;
  dislikes: number;
  comments: number;
  shares: number;
}

export interface YouTubeDailyAnalytics {
  date: string;
  views: number;
  watchTimeMinutes: number;
  subscribersGained: number;
  subscribersLost: number;
  likes: number;
  comments: number;
  shares: number;
}

export interface YouTubeTopVideo {
  videoId: string;
  title: string;
  thumbnail: string;
  views: number;
  watchTimeMinutes: number;
  likes: number;
  comments: number;
}

// ============================================================================
// YouTube Comments types
// ============================================================================

export interface YouTubeComment {
  id: string;
  videoId: string;
  videoTitle?: string;
  authorDisplayName: string;
  authorProfileImageUrl: string;
  authorChannelId?: string;
  textDisplay: string;
  textOriginal: string;
  likeCount: number;
  publishedAt: string;
  updatedAt?: string;
  replyCount: number;
  canReply?: boolean;
  moderationStatus?: string;
}

// ============================================================================
// Content Plan types (used by planning, quality, scheduling tools)
// ============================================================================

export interface ContentPlanPost {
  id: string;
  day: number;
  date: string;
  platform: Platform;
  content_type: ContentType;
  caption: string;
  title?: string;
  hashtags?: string[];
  hook: string;
  angle: string;
  visual_direction?: string;
  media_type?: 'image' | 'video' | 'carousel' | 'text-only';
  media_url?: string;
  schedule_at?: string;
  quality?: { score: number; max_score: number; passed: boolean; blockers: string[] };
  schedule_result?: { success: boolean; post_id?: string; job_id?: string; error?: string };
  status?: 'pending' | 'approved' | 'rejected' | 'needs_edit' | 'edited';
}

export interface ContentPlan {
  plan_id: string;
  generated_at: string;
  topic: string;
  source_url?: string;
  brand_name?: string;
  project_id?: string;
  start_date: string;
  end_date: string;
  platforms: Platform[];
  estimated_credits: number;
  posts: ContentPlanPost[];
  context_used?: {
    ideation_context?: Record<string, unknown>;
    loop_summary?: Record<string, unknown>;
    project_id?: string;
  };
  insights_applied?: {
    top_hooks: string[];
    optimal_timing: { dayOfWeek: number; hourOfDay: number; timezone?: string } | null;
    recommended_model: string | null;
    winning_patterns: {
      hookTypes: string[];
      contentFormats: string[];
      ctaStyles: string[];
    };
    insights_count: number;
    has_historical_data: boolean;
  };
  quality_summary?: { total_posts: number; passed: number; failed: number; avg_score: number };
  schedule_summary?: { total_posts: number; scheduled: number; failed: number };
}

export interface ExtractedContent {
  source_type: 'youtube_video' | 'youtube_channel' | 'article' | 'product';
  url: string;
  title: string;
  description: string;
  transcript?: string;
  video_metadata?: {
    views: number;
    likes: number;
    duration: number;
    tags: string[];
    channel_name: string;
  };
  features?: string[];
  benefits?: string[];
  usp?: string;
  suggested_hooks?: string[];
}

// ============================================================================
// Scheduling / Slot types
// ============================================================================

export interface PostingSlot {
  platform: string;
  datetime: string;
  day_of_week: number;
  hour: number;
  engagement_score: number;
  conflict: boolean;
}
