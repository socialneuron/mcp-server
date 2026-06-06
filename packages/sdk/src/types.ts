/**
 * TypeScript types for the Social Neuron REST API.
 */

// ── Enums ───────────────────────────────────────────────────────────

export type Platform =
  | "youtube"
  | "tiktok"
  | "instagram"
  | "twitter"
  | "linkedin"
  | "facebook"
  | "threads"
  | "bluesky";

export type ContentType = "script" | "caption" | "blog" | "hook" | "generation";

export type VideoModel =
  | "veo3-fast"
  | "veo3-quality"
  | "runway-aleph"
  | "sora2"
  | "sora2-pro"
  | "kling-3"
  | "kling-3-pro";

export type ImageModel =
  | "midjourney"
  | "nano-banana"
  | "nano-banana-pro"
  | "ideogram"
  | "flux-pro"
  | "flux-max"
  | "gpt4o-image"
  | "imagen4"
  | "imagen4-fast"
  | "seedream";

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";

export type JobStatus = "pending" | "processing" | "completed" | "failed";

// ── Response envelope ───────────────────────────────────────────────

export interface ApiResponse<T> {
  _meta: {
    version: string;
    timestamp: string;
    tool?: string;
  };
  data: T;
}

export interface ApiError {
  error: string;
  error_description: string;
  status: number;
  retry_after?: number;
}

// ── Content types ───────────────────────────────────────────────────

export interface GenerateContentParams {
  prompt: string;
  platform?: Platform;
  content_type?: ContentType;
  tone?: string;
  brand_voice?: string;
  project_id?: string;
}

export interface GenerateVideoParams {
  prompt: string;
  model?: VideoModel;
  aspect_ratio?: AspectRatio;
  duration?: number;
  image_url?: string;
  end_frame_url?: string;
  enable_audio?: boolean;
}

export interface GenerateImageParams {
  prompt: string;
  model?: ImageModel;
  aspect_ratio?: AspectRatio;
  style?: string;
  negative_prompt?: string;
}

export interface GenerateCarouselParams {
  topic: string;
  platform?: Platform;
  slides?: number;
  brand_voice?: string;
  project_id?: string;
}

export interface GenerateVoiceoverParams {
  text: string;
  voice?: string;
  language?: string;
}

export interface AdaptContentParams {
  content: string;
  source_platform?: Platform;
  target_platform: Platform;
  brand_voice?: string;
}

export interface FetchTrendsParams {
  source?: "youtube" | "google_trends" | "rss" | "url";
  category?: string;
  region?: string;
  limit?: number;
}

// ── Post types ──────────────────────────────────────────────────────

export interface SchedulePostParams {
  media_url?: string;
  media_urls?: string[];
  r2_key?: string;
  r2_keys?: string[];
  job_id?: string;
  job_ids?: string[];
  media_type?: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  caption?: string;
  title?: string;
  platforms: Platform[];
  schedule_at?: string;
  attribution?: boolean;
  auto_rehost?: boolean;
}

export interface ReschedulePostParams {
  schedule_at: string;
}

export interface UpdatePostParams {
  caption?: string;
  title?: string;
  hashtags?: string[];
  media_url?: string;
  media_type?: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  platforms?: Platform[];
  schedule_at?: string;
}

export interface ListPostsParams {
  platform?: Platform;
  status?: string;
  days?: number;
  limit?: number;
  offset?: number;
}

// ── Analytics types ─────────────────────────────────────────────────

export interface FetchAnalyticsParams {
  platform?: Platform;
  days?: number;
  limit?: number;
}

export interface YouTubeAnalyticsParams {
  days?: number;
  metrics?: string[];
}

export interface InsightsParams {
  project_id?: string;
  days?: number;
}

export interface PostingTimesParams {
  platform?: Platform;
  project_id?: string;
}

// ── Response data types ───────────────────────────────────────────────

export interface GenerateContentResult {
  text?: string;
  [key: string]: unknown;
}

export interface GenerateJobResult {
  taskId?: string;
  asyncJobId?: string | null;
  jobId?: string;
  status: string;
  model?: string;
  estimatedTime?: number;
  creditsDeducted?: number;
}

export interface PostRecord {
  id: string;
  platform: string;
  status: string;
  title: string | null;
  caption?: string | null;
  media_type?: string | null;
  media_url?: string | null;
  r2_key?: string | null;
  thumbnail_url?: string | null;
  job_id?: string | null;
  external_post_id: string | null;
  published_at: string | null;
  scheduled_at: string | null;
  created_at: string;
}

export interface SchedulePostResult {
  success: boolean;
  results: Record<string, { success: boolean; jobId?: string; postId?: string; error?: string }>;
  scheduledAt: string;
}

export interface PostMutationResult {
  success: boolean;
  post: PostRecord | null;
  scheduled_at?: string;
}

export interface ConnectedAccount {
  id: string;
  platform: string;
  status: string;
  username: string | null;
  created_at: string;
}

export interface ListPostsResult {
  posts: PostRecord[];
}

export interface ListAccountsResult {
  accounts: ConnectedAccount[];
}

export interface AnalyticsPost {
  id: string;
  platform: string;
  title: string | null;
  views: number;
  engagement: number;
  posted_at: string;
  content_type?: string | null;
  model_used?: string | null;
}

export interface AnalyticsSummary {
  platform: string | null;
  totalViews: number;
  totalEngagement: number;
  postCount: number;
  posts: AnalyticsPost[];
  days?: number;
}

export interface CreditBalance {
  balance: number;
  monthlyUsed: number;
  monthlyLimit: number;
  plan: string;
}

export interface BudgetStatus {
  creditsUsedThisRun: number;
  maxCreditsPerRun: number;
  remaining: number | null;
  assetsGeneratedThisRun: number;
  maxAssetsPerRun: number;
  remainingAssets: number | null;
}

// ── Brand types ─────────────────────────────────────────────────────

export interface SaveBrandParams {
  brand_context: Record<string, unknown>;
  change_summary?: string;
  changed_paths?: string[];
  source_url?: string;
  extraction_method?: string;
  overall_confidence?: number;
  project_id?: string;
}

export interface ExtractBrandParams {
  url: string;
}

// ── Plan types ──────────────────────────────────────────────────────

export interface CreatePlanParams {
  topic: string;
  platforms: Platform[];
  days?: number;
  brand_voice?: string;
  source_url?: string;
  project_id?: string;
}

export interface ListPlansParams {
  status?: string;
  project_id?: string;
  limit?: number;
  offset?: number;
}

export interface UpdatePlanParams {
  posts?: unknown[];
  topic?: string;
  status?: string;
}

export interface SchedulePlanParams {
  auto_slot?: boolean;
  batch_size?: number;
  dry_run?: boolean;
}

export interface ApprovePlanParams {
  action?: "approve" | "reject" | "needs_edit";
  post_ids?: string[];
  feedback?: string;
}

// ── Comment types ───────────────────────────────────────────────────

export interface ListCommentsParams {
  platform?: Platform;
  video_id?: string;
  post_id?: string;
  sort?: "time" | "relevance";
  limit?: number;
  offset?: number;
}

export interface PostCommentParams {
  video_id?: string;
  post_id?: string;
  text: string;
  platform?: Platform;
}

export interface ReplyCommentParams {
  text: string;
}

export interface ModerateCommentParams {
  action: "approve" | "hide" | "flag";
}

// ── Job types ───────────────────────────────────────────────────────

export interface JobResult {
  taskId: string;
  status: JobStatus;
  progress: number;
  resultUrl: string | null;
  allImageUrls: string[] | null;
  creditsUsed: number | null;
  error: string | null;
}

// ── Tool types ──────────────────────────────────────────────────────

export interface Tool {
  name: string;
  description: string;
  module: string;
  scope: string;
}

export interface ListToolsParams {
  query?: string;
  module?: string;
  scope?: string;
}
