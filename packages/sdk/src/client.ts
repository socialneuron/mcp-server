import type {
  AdaptContentParams,
  ApiError,
  CancelAsyncJobParams,
  CancelScheduledPostParams,
  CreatePlanParams,
  CreateAutopilotConfigParams,
  DeleteCommentParams,
  DeleteAutopilotConfigParams,
  DeleteCarouselParams,
  DeleteContentPlanParams,
  ExtractBrandParams,
  ExecuteRecipeParams,
  FetchAnalyticsParams,
  FetchTrendsParams,
  GenerateCarouselParams,
  GenerateContentParams,
  GenerateImageParams,
  GenerateVideoParams,
  GenerateVoiceoverParams,
  InsightsParams,
  JobResult,
  LifecycleResult,
  ListCommentsParams,
  ListPostsParams,
  ListToolsResponse,
  ModerateCommentParams,
  PostCommentParams,
  PostingTimesParams,
  ReplyCommentParams,
  RespondPlanApprovalParams,
  ReschedulePostParams,
  SaveBrandParams,
  SavePlanParams,
  SchedulePlanParams,
  SchedulePostParams,
  ToolContentBlock,
  ToolResponse,
  UpdatePlanParams,
  UpdateAutopilotConfigParams,
  YouTubeAnalyticsParams,
} from "./types.js";

export interface SocialNeuronConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

interface RawToolResponse {
  content?: ToolContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

function validateApiKey(value: string): void {
  if (
    value.length < 32 ||
    value.length > 512 ||
    !/^snk_(?:live|test)_[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error('Invalid API key format. Keys start with snk_live_ or snk_test_');
  }
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('baseUrl must be a valid absolute URL');
  }
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback.has(parsed.hostname))) {
    throw new Error('baseUrl must use HTTPS (HTTP is allowed only for loopback development)');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('baseUrl must not contain credentials, query parameters, or a fragment');
  }
  return parsed.toString().replace(/\/$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataFromEnvelope(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

function extractToolData(raw: RawToolResponse): unknown {
  if (raw.structuredContent !== undefined) {
    return dataFromEnvelope(raw.structuredContent);
  }

  const text = raw.content?.find((block) => block.type === "text")?.text;
  if (!text) return null;
  try {
    return dataFromEnvelope(JSON.parse(text));
  } catch {
    return text;
  }
}

class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(config: SocialNeuronConfig) {
    if (!config.apiKey) throw new Error("apiKey is required");
    validateApiKey(config.apiKey);
    if (
      config.timeout !== undefined &&
      (!Number.isFinite(config.timeout) || config.timeout <= 0 || config.timeout > 600_000)
    ) {
      throw new Error('timeout must be a positive number no greater than 600000ms');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? "https://mcp.socialneuron.com");
    this.timeout = config.timeout ?? 60_000;
  }

  async request<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await response.text();

      if (!response.ok) {
        throw new SocialNeuronError(parseApiError(responseText, response.status, response.headers));
      }

      if (!responseText) return undefined as T;
      return JSON.parse(responseText) as T;
    } catch (error) {
      if (error instanceof SocialNeuronError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new SocialNeuronError({
          error: "timeout",
          error_description: "The Social Neuron request timed out.",
          status: 408,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async callTool<T>(name: string, params: Record<string, unknown> = {}): Promise<ToolResponse<T>> {
    const raw = await this.request<RawToolResponse>(
      "POST",
      `/tools/${encodeURIComponent(name)}`,
      params,
    );
    return {
      content: raw.content ?? [],
      structuredContent: raw.structuredContent,
      isError: raw.isError,
      _meta: raw._meta,
      data: extractToolData(raw) as T,
    };
  }
}

function parseApiError(text: string, status: number, headers: Headers): ApiError {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  const outer = isRecord(body) ? body : {};
  const nested = isRecord(outer.error) ? outer.error : {};
  const legacyCode = typeof outer.error === "string" ? outer.error : undefined;
  const code =
    (typeof nested.error_type === "string" && nested.error_type) ||
    legacyCode ||
    (status === 401 ? "unauthorized" : "unknown_error");
  const description =
    (typeof nested.message === "string" && nested.message) ||
    (typeof outer.error_description === "string" && outer.error_description) ||
    `Social Neuron request failed with HTTP ${status}.`;
  const retryHeader = Number(headers.get("retry-after"));
  const retryBody = Number(outer.retry_after);

  return {
    error: code,
    error_description: description,
    status,
    retry_after: Number.isFinite(retryHeader)
      ? retryHeader
      : Number.isFinite(retryBody)
        ? retryBody
        : undefined,
    recover_with: Array.isArray(nested.recover_with)
      ? nested.recover_with.filter((item): item is string => typeof item === "string")
      : undefined,
  };
}

export class SocialNeuronError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter?: number;
  readonly recoverWith?: string[];

  constructor(error: ApiError) {
    super(error.error_description);
    this.name = "SocialNeuronError";
    this.code = error.error;
    this.status = error.status;
    this.retryAfter = error.retry_after;
    this.recoverWith = error.recover_with;
  }
}

const json = <T extends Record<string, unknown>>(params?: T): T & { response_format: "json" } =>
  ({ ...(params ?? ({} as T)), response_format: "json" });

class ContentResource {
  constructor(private readonly http: HttpClient) {}
  generate(params: GenerateContentParams) {
    return this.http.callTool("generate_content", params as unknown as Record<string, unknown>);
  }
  generateVideo(params: GenerateVideoParams) {
    return this.http.callTool("generate_video", json(params as unknown as Record<string, unknown>));
  }
  generateImage(params: GenerateImageParams) {
    return this.http.callTool("generate_image", json(params as unknown as Record<string, unknown>));
  }
  generateCarousel(params: GenerateCarouselParams) {
    return this.http.callTool("generate_carousel", json(params as unknown as Record<string, unknown>));
  }
  generateVoiceover(params: GenerateVoiceoverParams) {
    return this.http.callTool("generate_voiceover", json(params as unknown as Record<string, unknown>));
  }
  adapt(params: AdaptContentParams) {
    return this.http.callTool("adapt_content", params as unknown as Record<string, unknown>);
  }
  trends(params: FetchTrendsParams) {
    return this.http.callTool("fetch_trends", params as unknown as Record<string, unknown>);
  }
  deleteCarousel(params: DeleteCarouselParams) {
    return this.http.callTool<LifecycleResult>(
      "delete_carousel",
      params as unknown as Record<string, unknown>,
    );
  }
}

class PostsResource {
  constructor(private readonly http: HttpClient) {}
  schedule(params: SchedulePostParams) {
    return this.http.callTool("schedule_post", json(params as unknown as Record<string, unknown>));
  }
  reschedule(params: ReschedulePostParams) {
    return this.http.callTool("reschedule_post", json(params as unknown as Record<string, unknown>));
  }
  list(params: ListPostsParams = {}) {
    return this.http.callTool("list_recent_posts", json(params as unknown as Record<string, unknown>));
  }
  accounts(params: { project_id?: string } = {}) {
    return this.http.callTool("list_connected_accounts", json(params));
  }
  cancel(params: CancelScheduledPostParams) {
    return this.http.callTool<LifecycleResult>(
      "cancel_scheduled_post",
      params as unknown as Record<string, unknown>,
    );
  }
}

class AnalyticsResource {
  constructor(private readonly http: HttpClient) {}
  fetch(params: FetchAnalyticsParams = {}) {
    return this.http.callTool("fetch_analytics", json(params as unknown as Record<string, unknown>));
  }
  refresh(params: { project_id?: string } = {}) {
    return this.http.callTool("refresh_platform_analytics", json(params));
  }
  youtube(params: YouTubeAnalyticsParams) {
    return this.http.callTool("fetch_youtube_analytics", json(params as unknown as Record<string, unknown>));
  }
  insights(params: InsightsParams = {}) {
    return this.http.callTool("get_performance_insights", json(params as unknown as Record<string, unknown>));
  }
  postingTimes(params: PostingTimesParams = {}) {
    return this.http.callTool("get_best_posting_times", json(params as unknown as Record<string, unknown>));
  }
}

class BrandResource {
  constructor(private readonly http: HttpClient) {}
  get(params: { project_id?: string } = {}) {
    return this.http.callTool("get_brand_profile", json(params));
  }
  save(params: SaveBrandParams) {
    return this.http.callTool("save_brand_profile", json(params as unknown as Record<string, unknown>));
  }
  extract(params: ExtractBrandParams) {
    return this.http.callTool("extract_brand", json(params as unknown as Record<string, unknown>));
  }
}

class PlansResource {
  constructor(private readonly http: HttpClient) {}
  create(params: CreatePlanParams) {
    return this.http.callTool("plan_content_week", json(params as unknown as Record<string, unknown>));
  }
  save(params: SavePlanParams) {
    return this.http.callTool("save_content_plan", json(params as unknown as Record<string, unknown>));
  }
  get(planId: string) {
    return this.http.callTool("get_content_plan", json({ plan_id: planId }));
  }
  update(planId: string, params: UpdatePlanParams) {
    return this.http.callTool(
      "update_content_plan",
      json({ plan_id: planId, ...(params as unknown as Record<string, unknown>) }),
    );
  }
  schedule(planId: string, params: SchedulePlanParams = {}) {
    return this.http.callTool(
      "schedule_content_plan",
      json({ plan_id: planId, ...(params as unknown as Record<string, unknown>) }),
    );
  }
  submitForApproval(planId: string) {
    return this.http.callTool("submit_content_plan_for_approval", json({ plan_id: planId }));
  }
  approvals(planId: string, status?: "pending" | "approved" | "rejected" | "edited") {
    return this.http.callTool(
      "list_plan_approvals",
      json({ plan_id: planId, ...(status ? { status } : {}) }),
    );
  }
  respondApproval(params: RespondPlanApprovalParams) {
    return this.http.callTool(
      "respond_plan_approval",
      json(params as unknown as Record<string, unknown>),
    );
  }
  delete(params: DeleteContentPlanParams) {
    return this.http.callTool<LifecycleResult>(
      "delete_content_plan",
      params as unknown as Record<string, unknown>,
    );
  }
}

class CommentsResource {
  constructor(private readonly http: HttpClient) {}
  list(params: ListCommentsParams = {}) {
    return this.http.callTool("list_comments", json(params as unknown as Record<string, unknown>));
  }
  post(params: PostCommentParams) {
    return this.http.callTool("post_comment", json(params as unknown as Record<string, unknown>));
  }
  reply(commentId: string, params: ReplyCommentParams) {
    return this.http.callTool(
      "reply_to_comment",
      json({ parent_id: commentId, ...(params as unknown as Record<string, unknown>) }),
    );
  }
  moderate(commentId: string, params: ModerateCommentParams) {
    return this.http.callTool(
      "moderate_comment",
      json({ comment_id: commentId, ...(params as unknown as Record<string, unknown>) }),
    );
  }
  delete(commentId: string, params: DeleteCommentParams) {
    return this.http.callTool(
      "delete_comment",
      json({ comment_id: commentId, ...(params as unknown as Record<string, unknown>) }),
    );
  }
}

class JobsResource {
  constructor(private readonly http: HttpClient) {}
  check(jobId: string) {
    return this.http.callTool<JobResult>("check_status", json({ job_id: jobId }));
  }
  cancel(params: CancelAsyncJobParams) {
    return this.http.callTool<LifecycleResult>(
      "cancel_async_job",
      params as unknown as Record<string, unknown>,
    );
  }
  async waitForCompletion(
    jobId: string,
    options: { maxWaitMs?: number; initialIntervalMs?: number } = {},
  ): Promise<ToolResponse<JobResult>> {
    const maxWait = options.maxWaitMs ?? 300_000;
    let interval = options.initialIntervalMs ?? 3_000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const result = await this.check(jobId);
      if (result.isError || !isRecord(result.data) || typeof result.data.status !== "string") {
        throw new SocialNeuronError({
          error: "job_status_error",
          error_description: "Social Neuron could not read a valid status for this job.",
          status: 502,
        });
      }
      if (
        result.data.status === "completed" ||
        result.data.status === "failed" ||
        result.data.status === "cancelled" ||
        result.data.status === "canceled"
      ) return result;
      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(interval * 1.5, 15_000);
    }
    throw new SocialNeuronError({
      error: "job_timeout",
      error_description: `Job ${jobId} did not complete within ${maxWait}ms.`,
      status: 408,
    });
  }
}

class AutopilotResource {
  constructor(private readonly http: HttpClient) {}
  createConfiguration(params: CreateAutopilotConfigParams) {
    return this.http.callTool(
      "create_autopilot_config",
      json(params as unknown as Record<string, unknown>),
    );
  }
  updateConfiguration(params: UpdateAutopilotConfigParams) {
    return this.http.callTool(
      "update_autopilot_config",
      json(params as unknown as Record<string, unknown>),
    );
  }
  deleteConfiguration(params: DeleteAutopilotConfigParams) {
    return this.http.callTool<LifecycleResult>(
      "delete_autopilot_config",
      params as unknown as Record<string, unknown>,
    );
  }
}

class RecipesResource {
  constructor(private readonly http: HttpClient) {}
  list(params: { category?: string; featured_only?: boolean } = {}) {
    return this.http.callTool("list_recipes", json(params));
  }
  get(slug: string) {
    return this.http.callTool("get_recipe_details", json({ slug }));
  }
  execute(params: ExecuteRecipeParams) {
    return this.http.callTool(
      "execute_recipe",
      json(params as unknown as Record<string, unknown>),
    );
  }
  status(runId: string) {
    return this.http.callTool("get_recipe_run_status", json({ run_id: runId }));
  }
}

class ToolsResource {
  constructor(private readonly http: HttpClient) {}
  list() {
    return this.http.request<ListToolsResponse>("GET", "/tools");
  }
  execute<T = unknown>(toolName: string, params: Record<string, unknown> = {}) {
    return this.http.callTool<T>(toolName, params);
  }
}

class AccountResource {
  constructor(private readonly http: HttpClient) {}
  credits() {
    return this.http.callTool("get_credit_balance", json());
  }
  usage() {
    return this.http.callTool("get_mcp_usage", json());
  }
}

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
  readonly autopilot: AutopilotResource;
  readonly recipes: RecipesResource;

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
    this.autopilot = new AutopilotResource(http);
    this.recipes = new RecipesResource(http);
  }
}
