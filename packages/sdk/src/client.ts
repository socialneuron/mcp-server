/**
 * Social Neuron SDK Client
 *
 * Usage:
 *   import { SocialNeuron } from '@socialneuron/sdk';
 *   const sn = new SocialNeuron({ apiKey: 'snk_live_...' });
 *   const video = await sn.content.generateVideo({ prompt: '...' });
 *   const result = await sn.jobs.waitForCompletion(video.data.taskId);
 */

import type {
  ApiResponse,
  ApiError,
  GenerateContentParams,
  GenerateVideoParams,
  GenerateImageParams,
  GenerateCarouselParams,
  GenerateVoiceoverParams,
  AdaptContentParams,
  FetchTrendsParams,
  SchedulePostParams,
  ListPostsParams,
  FetchAnalyticsParams,
  YouTubeAnalyticsParams,
  InsightsParams,
  PostingTimesParams,
  SaveBrandParams,
  ExtractBrandParams,
  CreatePlanParams,
  ListPlansParams,
  UpdatePlanParams,
  SchedulePlanParams,
  ApprovePlanParams,
  ListCommentsParams,
  PostCommentParams,
  ReplyCommentParams,
  ModerateCommentParams,
  JobResult,
  ListToolsParams,
  Tool,
} from "./types.js";

// ── Configuration ───────────────────────────────────────────────────

export interface SocialNeuronConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

// ── HTTP Client ─────────────────────────────────────────────────────

class HttpClient {
  private apiKey: string;
  private baseUrl: string;
  private timeout: number;

  constructor(config: SocialNeuronConfig) {
    if (!config.apiKey) throw new Error("apiKey is required");
    if (!config.apiKey.startsWith("snk_live_")) {
      throw new Error("Invalid API key format. Keys start with snk_live_");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://mcp.socialneuron.com").replace(
      /\/$/,
      "",
    );
    this.timeout = config.timeout ?? 60_000;
  }

  async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<ApiResponse<T>> {
    const url = new URL(`${this.baseUrl}/v1${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const responseText = await response.text();

      if (!response.ok) {
        let error: ApiError;
        try {
          error = JSON.parse(responseText) as ApiError;
        } catch {
          error = {
            error: "unknown",
            error_description: responseText || `HTTP ${response.status}`,
            status: response.status,
          };
        }
        throw new SocialNeuronError(error);
      }

      return JSON.parse(responseText) as ApiResponse<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ) {
    return this.request<T>("GET", path, undefined, query);
  }

  post<T>(path: string, body?: Record<string, unknown>) {
    return this.request<T>("POST", path, body);
  }

  put<T>(path: string, body?: Record<string, unknown>) {
    return this.request<T>("PUT", path, body);
  }

  delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }
}

// ── Error class ─────────────────────────────────────────────────────

export class SocialNeuronError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter?: number;

  constructor(error: ApiError) {
    super(error.error_description);
    this.name = "SocialNeuronError";
    this.code = error.error;
    this.status = error.status;
    this.retryAfter = error.retry_after;
  }
}

// ── Resource classes ────────────────────────────────────────────────

class ContentResource {
  constructor(private http: HttpClient) {}

  generate(params: GenerateContentParams) {
    return this.http.post<unknown>("/content/generate", params as Record<string, unknown>);
  }

  generateVideo(params: GenerateVideoParams) {
    return this.http.post<unknown>("/content/video", params as Record<string, unknown>);
  }

  generateImage(params: GenerateImageParams) {
    return this.http.post<unknown>("/content/image", params as Record<string, unknown>);
  }

  generateCarousel(params: GenerateCarouselParams) {
    return this.http.post<unknown>("/content/carousel", params as Record<string, unknown>);
  }

  generateVoiceover(params: GenerateVoiceoverParams) {
    return this.http.post<unknown>("/content/voiceover", params as Record<string, unknown>);
  }

  adapt(params: AdaptContentParams) {
    return this.http.post<unknown>("/content/adapt", params as Record<string, unknown>);
  }

  trends(params?: FetchTrendsParams) {
    return this.http.get<unknown>("/content/trends", params as Record<string, string | number | boolean | undefined>);
  }
}

class PostsResource {
  constructor(private http: HttpClient) {}

  schedule(params: SchedulePostParams) {
    return this.http.post<unknown>("/posts", params as Record<string, unknown>);
  }

  list(params?: ListPostsParams) {
    return this.http.get<unknown>("/posts", params as Record<string, string | number | boolean | undefined>);
  }

  accounts() {
    return this.http.get<unknown>("/posts/accounts");
  }
}

class AnalyticsResource {
  constructor(private http: HttpClient) {}

  fetch(params?: FetchAnalyticsParams) {
    return this.http.get<unknown>("/analytics", params as Record<string, string | number | boolean | undefined>);
  }

  refresh(params?: { platform?: string }) {
    return this.http.post<unknown>("/analytics/refresh", params);
  }

  youtube(params?: YouTubeAnalyticsParams) {
    const query: Record<string, string | number | boolean | undefined> = {
      days: params?.days,
      metrics: params?.metrics?.join(","),
    };
    return this.http.get<unknown>("/analytics/youtube", query);
  }

  insights(params?: InsightsParams) {
    return this.http.get<unknown>("/analytics/insights", params as Record<string, string | number | boolean | undefined>);
  }

  postingTimes(params?: PostingTimesParams) {
    return this.http.get<unknown>("/analytics/posting-times", params as Record<string, string | number | boolean | undefined>);
  }
}

class BrandResource {
  constructor(private http: HttpClient) {}

  get(params?: { project_id?: string }) {
    return this.http.get<unknown>("/brand", params as Record<string, string | number | boolean | undefined>);
  }

  save(params: SaveBrandParams) {
    return this.http.put<unknown>("/brand", params as Record<string, unknown>);
  }

  extract(params: ExtractBrandParams) {
    return this.http.post<unknown>("/brand/extract", params as Record<string, unknown>);
  }
}

class PlansResource {
  constructor(private http: HttpClient) {}

  create(params: CreatePlanParams) {
    return this.http.post<unknown>("/plans", params as Record<string, unknown>);
  }

  list(params?: ListPlansParams) {
    return this.http.get<unknown>("/plans", params as Record<string, string | number | boolean | undefined>);
  }

  get(id: string) {
    return this.http.get<unknown>(`/plans/${id}`);
  }

  update(id: string, params: UpdatePlanParams) {
    return this.http.put<unknown>(`/plans/${id}`, params as Record<string, unknown>);
  }

  schedule(id: string, params?: SchedulePlanParams) {
    return this.http.post<unknown>(`/plans/${id}/schedule`, params as Record<string, unknown>);
  }

  approve(id: string, params?: ApprovePlanParams) {
    return this.http.post<unknown>(`/plans/${id}/approve`, params as Record<string, unknown>);
  }

  approvals(params?: { plan_id?: string; status?: string; limit?: number }) {
    return this.http.get<unknown>("/plans/approvals", params as Record<string, string | number | boolean | undefined>);
  }
}

class CommentsResource {
  constructor(private http: HttpClient) {}

  list(params?: ListCommentsParams) {
    return this.http.get<unknown>("/comments", params as Record<string, string | number | boolean | undefined>);
  }

  post(params: PostCommentParams) {
    return this.http.post<unknown>("/comments", params as Record<string, unknown>);
  }

  reply(commentId: string, params: ReplyCommentParams) {
    return this.http.post<unknown>(`/comments/${commentId}/reply`, params as Record<string, unknown>);
  }

  moderate(commentId: string, params: ModerateCommentParams) {
    return this.http.post<unknown>(`/comments/${commentId}/moderate`, params as Record<string, unknown>);
  }

  delete(commentId: string) {
    return this.http.delete<void>(`/comments/${commentId}`);
  }
}

class JobsResource {
  constructor(private http: HttpClient) {}

  check(jobId: string) {
    return this.http.get<JobResult>(`/jobs/${jobId}`);
  }

  /**
   * Poll a job until it completes or fails.
   * Uses exponential backoff with a configurable max wait.
   */
  async waitForCompletion(
    jobId: string,
    options?: { maxWaitMs?: number; initialIntervalMs?: number },
  ): Promise<ApiResponse<JobResult>> {
    const maxWait = options?.maxWaitMs ?? 300_000; // 5 minutes
    let interval = options?.initialIntervalMs ?? 3_000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const result = await this.check(jobId);
      const status = result.data.status;

      if (status === "completed" || status === "failed") {
        return result;
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(interval * 1.5, 15_000); // Max 15s between polls
    }

    throw new Error(`Job ${jobId} did not complete within ${maxWait}ms`);
  }
}

class ToolsResource {
  constructor(private http: HttpClient) {}

  list(params?: ListToolsParams) {
    return this.http.get<{ tools: Tool[]; total: number }>("/tools", params as Record<string, string | number | boolean | undefined>);
  }

  execute(toolName: string, params?: Record<string, unknown>) {
    return this.http.post<unknown>(`/tools/${toolName}`, params);
  }
}

class AccountResource {
  constructor(private http: HttpClient) {}

  credits() {
    return this.http.get<unknown>("/credits");
  }

  usage() {
    return this.http.get<unknown>("/usage");
  }
}

// ── Main Client ─────────────────────────────────────────────────────

export class SocialNeuron {
  readonly content: ContentResource;
  readonly posts: PostsResource;
  readonly analytics: AnalyticsResource;
  readonly brand: BrandResource;
  readonly plans: PlansResource;
  readonly comments: CommentsResource;
  readonly jobs: JobsResource;
  readonly tools: ToolsResource;
  readonly account: AccountResource;

  constructor(config: SocialNeuronConfig) {
    const http = new HttpClient(config);
    this.content = new ContentResource(http);
    this.posts = new PostsResource(http);
    this.analytics = new AnalyticsResource(http);
    this.brand = new BrandResource(http);
    this.plans = new PlansResource(http);
    this.comments = new CommentsResource(http);
    this.jobs = new JobsResource(http);
    this.tools = new ToolsResource(http);
    this.account = new AccountResource(http);
  }
}
