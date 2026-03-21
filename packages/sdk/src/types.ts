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
  | "kling"
  | "luma"
  | "midjourney-video";

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
  reference_image_url?: string;
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
  target_platforms: Platform[];
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
  media_type?: "video" | "image" | "carousel";
  caption?: string;
  title?: string;
  platforms: Platform[];
  scheduled_at?: string;
  attribution?: boolean;
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
