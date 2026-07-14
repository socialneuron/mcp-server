/** TypeScript types for the hosted Social Neuron tool-proxy API. */

export type Platform =
  | "youtube"
  | "tiktok"
  | "instagram"
  | "twitter"
  | "linkedin"
  | "facebook"
  | "threads"
  | "bluesky";

export type ContentType = "script" | "caption" | "blog" | "hook";

/** Models currently exposed by the generate_video MCP/REST tool. */
export type VideoModel =
  | "seedance-2-fast"
  | "kling-3"
  | "grok-imagine"
  | "veo3-fast"
  | "kling-3-pro"
  | "seedance-2"
  | "veo3-quality"
  | "wan-2.6"
  | "gemini-omni-video"
  | "hailuo-02-standard"
  | "seedance-1.5-pro"
  | "kling";

export type ImageModel =
  | "midjourney"
  | "nano-banana"
  | "nano-banana-pro"
  | "flux-pro"
  | "flux-max"
  | "gpt4o-image"
  | "imagen4"
  | "imagen4-fast"
  | "seedream";

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
export type JobStatus =
  | "queued"
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "canceled";

export type BillingStatus =
  | "reserved"
  | "charged"
  | "refunded"
  | "failed_no_charge"
  | "refund_pending"
  | "not_charged"
  | "unknown";

export interface ToolContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Raw MCP result plus a normalized `data` convenience field. */
export interface ToolResponse<T = unknown> {
  content: ToolContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  data: T;
}

export interface ApiError {
  error: string;
  error_description: string;
  status: number;
  retry_after?: number;
  recover_with?: string[];
}

export interface GenerateContentParams {
  prompt: string;
  content_type: ContentType;
  platform?: Platform;
  brand_voice?: string;
  model?: "gemini-2.5-flash" | "gemini-2.5-pro";
  project_id?: string;
}

export interface GenerateVideoParams {
  prompt: string;
  model: VideoModel;
  duration?: number;
  aspect_ratio?: Extract<AspectRatio, "16:9" | "9:16" | "1:1">;
  enable_audio?: boolean;
  image_url?: string;
  end_frame_url?: string;
  project_id?: string;
  response_format?: "text" | "json";
}

export interface GenerateImageParams {
  prompt: string;
  model: ImageModel;
  aspect_ratio?: AspectRatio;
  image_url?: string;
  project_id?: string;
  response_format?: "text" | "json";
}

export interface GenerateCarouselParams {
  topic: string;
  template_id?:
    | "educational-series"
    | "product-showcase"
    | "story-arc"
    | "before-after"
    | "step-by-step"
    | "quote-collection"
    | "data-stats"
    | "myth-vs-reality"
    | "hormozi-authority";
  slide_count?: number;
  aspect_ratio?: "1:1" | "4:5" | "9:16";
  style?: "minimal" | "bold" | "professional" | "playful" | "hormozi";
  hook?: string;
  hook_family?: "curiosity" | "authority" | "pain_point" | "contrarian" | "data_driven";
  cta_text?: string;
  cta_url?: string;
  tone?: string;
  constraints?: string;
  platform?: "linkedin" | "instagram" | "tiktok" | "x";
  project_id?: string;
  response_format?: "text" | "json";
}

export interface GenerateVoiceoverParams {
  text: string;
  voice?: "rachel" | "domi";
  speed?: number;
  project_id?: string;
  response_format?: "text" | "json";
}

export interface AdaptContentParams {
  content: string;
  source_platform?: Platform;
  target_platform: Platform;
  brand_voice?: string;
  project_id?: string;
}

export interface FetchTrendsParams {
  source: "youtube" | "google_trends" | "rss" | "url";
  category?: string;
  niche?: string;
  url?: string;
  force_refresh?: boolean;
}

export interface SchedulePostParams {
  project_id?: string;
  account_id?: string;
  account_ids?: Partial<Record<Platform, string>>;
  media_url?: string;
  media_urls?: string[];
  job_id?: string;
  job_ids?: string[];
  r2_key?: string;
  r2_keys?: string[];
  media_type?: "VIDEO" | "IMAGE" | "CAROUSEL_ALBUM";
  caption?: string;
  title?: string;
  hashtags?: string[];
  platforms: Platform[];
  schedule_at?: string;
  idempotency_key?: string;
  attribution?: boolean;
  auto_rehost?: boolean;
  platform_metadata?: {
    youtube?: {
      title?: string;
      description?: string;
      privacy_status?: "public" | "unlisted" | "private";
      category_id?: string;
      tags?: string[];
      made_for_kids?: boolean;
      notify_subscribers?: boolean;
      contains_synthetic_media?: boolean;
    };
    [platform: string]: Record<string, unknown> | undefined;
  };
  response_format?: "text" | "json";
}

export interface ReschedulePostParams {
  post_id: string;
  project_id?: string;
  scheduled_at: string;
  expected_scheduled_at?: string;
  response_format?: "text" | "json";
}

export interface ConfirmedProjectAction {
  project_id?: string;
  confirm: true;
}

export interface CancelAsyncJobParams extends ConfirmedProjectAction {
  job_id: string;
}

export interface CancelScheduledPostParams extends ConfirmedProjectAction {
  post_id: string;
}

export interface DeleteCarouselParams extends ConfirmedProjectAction {
  content_id: string;
}

export interface DeleteContentPlanParams extends ConfirmedProjectAction {
  plan_id: string;
}

export interface DeleteAutopilotConfigParams extends ConfirmedProjectAction {
  config_id: string;
}

export interface LifecycleResult {
  success?: boolean;
  cancelled?: boolean;
  deleted?: boolean;
  refunded_credits?: number;
  refund_status?: string;
  post_id?: string;
  content_id?: string;
  plan_id?: string;
  config_id?: string;
  jobs_cancelled?: number;
  status?: string;
  message?: string;
}

export interface ListPostsParams {
  project_id?: string;
  platform?: Platform;
  status?: string;
  limit?: number;
  response_format?: "text" | "json";
}

export interface FetchAnalyticsParams {
  platform?: Platform;
  days?: number;
  content_id?: string;
  project_id?: string;
  limit?: number;
  response_format?: "text" | "json";
}

export interface YouTubeAnalyticsParams {
  action: "channel" | "daily" | "video" | "topVideos";
  start_date: string;
  end_date: string;
  video_id?: string;
  max_results?: number;
  response_format?: "text" | "json";
}

export interface InsightsParams {
  insight_type?: "top_hooks" | "optimal_timing" | "best_models" | "competitor_patterns";
  project_id?: string;
  days?: number;
  limit?: number;
  response_format?: "text" | "json";
}

export interface PostingTimesParams {
  platform?: Platform;
  project_id?: string;
  response_format?: "text" | "json";
}

export interface SaveBrandParams {
  brand_context: Record<string, unknown>;
  change_summary?: string;
  changed_paths?: string[];
  source_url?: string;
  extraction_method?: "manual" | "url_extract" | "business_profiler" | "product_showcase";
  overall_confidence?: number;
  extraction_metadata?: Record<string, unknown>;
  project_id?: string;
  response_format?: "text" | "json";
}

export interface ExtractBrandParams {
  url: string;
  response_format?: "text" | "json";
}

export interface CreatePlanParams {
  topic: string;
  source_url?: string;
  platforms: Platform[];
  posts_per_day?: number;
  days?: number;
  start_date?: string;
  brand_voice?: string;
  project_id?: string;
  response_format?: "text" | "json";
}

export interface SavePlanParams {
  plan: { topic: string; posts: Record<string, unknown>[]; [key: string]: unknown };
  project_id?: string;
  status?: "draft" | "in_review" | "approved" | "scheduled" | "completed";
  response_format?: "text" | "json";
}

export interface UpdatePlanParams {
  post_updates: Array<{
    post_id: string;
    caption?: string;
    title?: string;
    hashtags?: string[];
    hook?: string;
    angle?: string;
    visual_direction?: string;
    media_url?: string;
    schedule_at?: string;
    platform?: string;
    status?: "approved" | "rejected" | "needs_edit";
  }>;
  response_format?: "text" | "json";
}

export interface SchedulePlanParams {
  auto_slot?: boolean;
  batch_size?: number;
  dry_run?: boolean;
  enforce_quality?: boolean;
  quality_threshold?: number;
  idempotency_seed?: string;
  response_format?: "text" | "json";
}

export interface ListCommentsParams {
  video_id?: string;
  max_results?: number;
  page_token?: string;
  response_format?: "text" | "json";
}

export interface PostCommentParams {
  video_id: string;
  text: string;
  response_format?: "text" | "json";
}

export interface ReplyCommentParams {
  text: string;
  response_format?: "text" | "json";
}

export interface ModerateCommentParams {
  moderation_status: "published" | "rejected";
  response_format?: "text" | "json";
}

export interface JobResult {
  id?: string;
  job_id?: string;
  taskId?: string;
  status: JobStatus;
  progress?: number;
  result_url?: string | null;
  resultUrl?: string | null;
  all_urls?: string[] | null;
  credits_cost?: number | null;
  credits_reserved?: number | null;
  credits_charged?: number | null;
  credits_refunded?: number | null;
  billing_status?: BillingStatus | null;
  failure_reason?: string | null;
  error?: string | null;
  error_message?: string | null;
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  description: string;
  module: string;
  scope?: string;
  available?: boolean;
}

export interface ListToolsResponse {
  tools: Tool[];
  count: number;
}
