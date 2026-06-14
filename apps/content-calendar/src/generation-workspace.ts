import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';

type GenerationType = 'image' | 'video';

interface WorkspacePayload {
  scopes?: string[];
  generation_type?: GenerationType;
  prompt?: string;
  model?: string;
  aspect_ratio?: string;
  platform?: string;
  job_id?: string;
  auto_start?: boolean;
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Partial<WorkspacePayload>;
  _meta?: { 'mcp/www_authenticate'?: unknown };
  content?: Array<{ type: string; text?: string }>;
}

interface JobState {
  jobId: string | null;
  type: GenerationType;
  model: string;
  status: string;
  progress: number;
  resultUrl: string | null;
  r2Key: string | null;
  allUrls: string[];
  error: string | null;
  credits: number | null;
  createdAt: string | null;
}

const PLATFORMS = [
  'youtube',
  'tiktok',
  'instagram',
  'twitter',
  'linkedin',
  'facebook',
  'threads',
  'bluesky',
] as const;

const IMAGE_MODELS = [
  'imagen4-fast',
  'imagen4',
  'flux-pro',
  'flux-max',
  'gpt4o-image',
  'midjourney',
  'nano-banana',
  'nano-banana-pro',
  'seedream',
] as const;

const VIDEO_MODELS = [
  'veo3-fast',
  'veo3-quality',
  'sora2',
  'sora2-pro',
  'kling-3',
  'kling-3-pro',
  'runway-aleph',
] as const;

const IMAGE_ASPECTS = ['1:1', '9:16', '16:9', '4:3', '3:4'] as const;
const VIDEO_ASPECTS = ['9:16', '16:9', '1:1'] as const;

const SCOPE_HIERARCHY: Record<string, string[]> = {
  'mcp:full': [
    'mcp:read',
    'mcp:write',
    'mcp:distribute',
    'mcp:analytics',
    'mcp:comments',
    'mcp:autopilot',
  ],
};

const state: {
  scopes: string[];
  type: GenerationType;
  prompt: string;
  model: string;
  aspectRatio: string;
  duration: number;
  platform: string;
  caption: string;
  scheduleAt: string;
  activeJob: JobState;
  busy: boolean;
  polling: boolean;
  autoStarted: boolean;
} = {
  scopes: [],
  type: 'image',
  prompt: '',
  model: 'imagen4-fast',
  aspectRatio: '1:1',
  duration: 5,
  platform: 'instagram',
  caption: '',
  scheduleAt: defaultScheduleAt(),
  activeJob: emptyJob('image'),
  busy: false,
  polling: false,
  autoStarted: false,
};

const app = new App({ name: 'Generation Workspace', version: '0.1.0' });

// Adopt Claude's theme tokens so the workspace matches the host light/dark mode.
function applyHostContext(ctx: Partial<McpUiHostContext> | undefined): void {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}
app.addEventListener('hostcontextchanged', (changed) => applyHostContext(changed));

// Keep Claude in the loop about what the user did inside the app.
function pushWorkspaceContext(summary: string): void {
  void app.updateModelContext({ content: [{ type: 'text', text: summary }] });
}

app.connect().then(() => applyHostContext(app.getHostContext()));

let pollTimer: number | null = null;

app.ontoolresult = (result) => {
  try {
    const payload = readWorkspacePayload(result as ToolResult);
    applyPayload(payload);
    renderAll();
    if (payload.auto_start && !state.autoStarted) {
      state.autoStarted = true;
      void startGeneration();
    } else if (payload.job_id) {
      void pollStatus();
    }
  } catch (err) {
    showToast(`Failed to load workspace payload: ${(err as Error).message}`, 'error');
  }
};

function readWorkspacePayload(result: ToolResult): WorkspacePayload {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as WorkspacePayload;
  }

  const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as WorkspacePayload;
}

document.addEventListener('DOMContentLoaded', () => {
  bindControls();
  renderAll();
});

function emptyJob(type: GenerationType): JobState {
  return {
    jobId: null,
    type,
    model: '',
    status: 'idle',
    progress: 0,
    resultUrl: null,
    r2Key: null,
    allUrls: [],
    error: null,
    credits: null,
    createdAt: null,
  };
}

function hasScope(userScopes: string[], required: string): boolean {
  if (userScopes.includes(required)) return true;
  return userScopes.some((scope) => SCOPE_HIERARCHY[scope]?.includes(required));
}

function canWrite(): boolean {
  return hasScope(state.scopes, 'mcp:write');
}

function canDistribute(): boolean {
  return hasScope(state.scopes, 'mcp:distribute');
}

function isScopeDenied(result: ToolResult): boolean {
  if (result._meta?.['mcp/www_authenticate']) return true;

  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  if (text.startsWith('Permission denied:')) return true;

  try {
    const parsed = JSON.parse(text) as { error?: string };
    return parsed.error === 'permission_denied';
  } catch {
    return false;
  }
}

function defaultScheduleAt(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function applyPayload(payload: WorkspacePayload) {
  state.scopes = payload.scopes ?? state.scopes;
  if (payload.generation_type === 'image' || payload.generation_type === 'video') {
    state.type = payload.generation_type;
  }
  if (payload.prompt) state.prompt = payload.prompt;
  if (payload.platform && PLATFORMS.includes(payload.platform as (typeof PLATFORMS)[number])) {
    state.platform = payload.platform;
  }
  if (payload.model) state.model = payload.model;
  if (payload.aspect_ratio) state.aspectRatio = payload.aspect_ratio;
  if (payload.job_id) {
    state.activeJob = {
      ...emptyJob(state.type),
      jobId: payload.job_id,
      model: payload.model ?? state.model,
      status: 'queued',
    };
  }
  normalizeModelAndAspect();
}

function bindControls() {
  byId<HTMLTextAreaElement>('prompt').addEventListener('input', (ev) => {
    state.prompt = (ev.currentTarget as HTMLTextAreaElement).value;
  });

  byId<HTMLSelectElement>('model').addEventListener('change', (ev) => {
    state.model = (ev.currentTarget as HTMLSelectElement).value;
  });

  byId<HTMLSelectElement>('aspect').addEventListener('change', (ev) => {
    state.aspectRatio = (ev.currentTarget as HTMLSelectElement).value;
  });

  byId<HTMLInputElement>('duration').addEventListener('input', (ev) => {
    state.duration = Number((ev.currentTarget as HTMLInputElement).value) || 5;
  });

  byId<HTMLSelectElement>('platform').addEventListener('change', (ev) => {
    state.platform = (ev.currentTarget as HTMLSelectElement).value;
    byId<HTMLSelectElement>('schedule-platform').value = state.platform;
  });

  byId<HTMLSelectElement>('schedule-platform').addEventListener('change', (ev) => {
    state.platform = (ev.currentTarget as HTMLSelectElement).value;
  });

  byId<HTMLTextAreaElement>('caption').addEventListener('input', (ev) => {
    state.caption = (ev.currentTarget as HTMLTextAreaElement).value;
  });

  byId<HTMLInputElement>('schedule-at').addEventListener('input', (ev) => {
    state.scheduleAt = (ev.currentTarget as HTMLInputElement).value;
  });

  byId<HTMLButtonElement>('generate').addEventListener('click', () => void startGeneration());
  byId<HTMLButtonElement>('poll').addEventListener('click', () => void pollStatus());
  byId<HTMLButtonElement>('auto-poll').addEventListener('click', toggleAutoPoll);
  byId<HTMLButtonElement>('clear').addEventListener('click', clearJob);
  byId<HTMLButtonElement>('schedule').addEventListener('click', () => void scheduleResult());
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

function renderAll() {
  normalizeModelAndAspect();
  renderTypeToggle();
  renderSelects();
  renderFormValues();
  renderStatus();
  renderPreview();
  renderProgress();
  renderMeta();
  renderButtonStates();
}

function renderTypeToggle() {
  const root = byId<HTMLDivElement>('type-toggle');
  const buttons = (['image', 'video'] as const).map((type) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = state.type === type ? 'active' : '';
    button.textContent = type;
    button.addEventListener('click', () => {
      state.type = type;
      state.activeJob = emptyJob(type);
      normalizeModelAndAspect();
      renderAll();
    });
    return button;
  });
  root.replaceChildren(...buttons);
}

function renderSelects() {
  fillSelect(byId<HTMLSelectElement>('model'), modelsForType(), state.model);
  fillSelect(byId<HTMLSelectElement>('aspect'), aspectsForType(), state.aspectRatio);
  fillSelect(byId<HTMLSelectElement>('platform'), [...PLATFORMS], state.platform);
  fillSelect(byId<HTMLSelectElement>('schedule-platform'), [...PLATFORMS], state.platform);
  byId<HTMLDivElement>('video-fields').style.display = state.type === 'video' ? 'grid' : 'none';
}

function renderFormValues() {
  byId<HTMLTextAreaElement>('prompt').value = state.prompt;
  byId<HTMLInputElement>('duration').value = String(state.duration);
  byId<HTMLTextAreaElement>('caption').value = state.caption;
  byId<HTMLInputElement>('schedule-at').value = state.scheduleAt;
}

function fillSelect(select: HTMLSelectElement, values: readonly string[], selected: string) {
  const options = values.map((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    option.selected = value === selected;
    return option;
  });
  select.replaceChildren(...options);
}

function modelsForType(): readonly string[] {
  return state.type === 'image' ? IMAGE_MODELS : VIDEO_MODELS;
}

function aspectsForType(): readonly string[] {
  return state.type === 'image' ? IMAGE_ASPECTS : VIDEO_ASPECTS;
}

function normalizeModelAndAspect() {
  if (!modelsForType().includes(state.model)) {
    state.model = state.type === 'image' ? IMAGE_MODELS[0] : VIDEO_MODELS[0];
  }
  if (!aspectsForType().includes(state.aspectRatio)) {
    state.aspectRatio = state.type === 'image' ? IMAGE_ASPECTS[0] : VIDEO_ASPECTS[0];
  }
}

function renderStatus() {
  const status = byId<HTMLDivElement>('status-bar');
  const job = state.activeJob;
  const statusClass = statusClassFor(job.status);
  status.replaceChildren(
    pill(canWrite() ? 'Write enabled' : 'Read-only', canWrite() ? 'ok' : 'warn'),
    pill(canDistribute() ? 'Schedule enabled' : 'No distribute scope', canDistribute() ? 'ok' : 'warn'),
    pill(job.status, statusClass),
    pill(state.type, 'neutral')
  );
}

function pill(text: string, kind: 'ok' | 'warn' | 'error' | 'neutral'): HTMLElement {
  const node = document.createElement('span');
  node.className = `pill ${kind === 'neutral' ? '' : kind}`.trim();
  node.textContent = text;
  return node;
}

function statusClassFor(status: string): 'ok' | 'warn' | 'error' | 'neutral' {
  const normalized = status.toLowerCase();
  if (normalized === 'completed' || normalized === 'succeeded') return 'ok';
  if (normalized === 'failed' || normalized === 'error') return 'error';
  if (normalized === 'processing' || normalized === 'pending' || normalized === 'queued') return 'warn';
  return 'neutral';
}

const ACTIVE_STATUSES = ['queued', 'processing', 'pending', 'starting', 'running', 'in_progress'];

function aspectToCss(ratio: string): string {
  const parts = ratio.split(':');
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[0]} / ${parts[1]}` : '1 / 1';
}

function stageLabel(progress: number, type: GenerationType): string {
  const p = Number(progress) || 0;
  if (p < 5) return 'Queued';
  if (p < 60) return type === 'video' ? 'Generating video…' : 'Generating image…';
  if (p < 90) return type === 'video' ? 'Rendering frames…' : 'Refining details…';
  return 'Finalizing…';
}

function renderPreview() {
  const root = byId<HTMLDivElement>('preview');
  const job = state.activeJob;
  const url = job.resultUrl ?? job.allUrls[0] ?? null;

  if (url && state.type === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Generated image preview';
    root.replaceChildren(img);
    return;
  }

  if (url && state.type === 'video') {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.playsInline = true;
    root.replaceChildren(video);
    return;
  }

  // Generating state — shimmer skeleton shaped like the result, with a staged
  // status line driven by poll progress (Canva/Codex-style loading).
  if (job.jobId && ACTIVE_STATUSES.includes(job.status.toLowerCase()) && !url) {
    const skeleton = document.createElement('div');
    skeleton.className = 'gen-skeleton';
    skeleton.style.aspectRatio = aspectToCss(state.aspectRatio);

    const overlay = document.createElement('div');
    overlay.className = 'gen-overlay';

    const dot = document.createElement('div');
    dot.className = 'gen-dot';

    const stage = document.createElement('div');
    stage.className = 'gen-stage';
    stage.textContent = stageLabel(job.progress, state.type);

    const sub = document.createElement('div');
    sub.className = 'gen-sub';
    const pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
    sub.textContent = pct > 0 ? `${pct}% · ${job.model || state.model}` : `Starting · ${job.model || state.model}`;

    overlay.append(dot, stage, sub);
    skeleton.append(overlay);
    root.replaceChildren(skeleton);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'preview-inner';
  const title = document.createElement('p');
  title.className = 'empty-title';
  title.textContent = job.jobId ? `Waiting for ${state.type} result` : 'No active generation';
  const copy = document.createElement('p');
  copy.className = 'empty-copy';
  copy.textContent = job.jobId
    ? 'Poll status until the result is ready. R2-backed media can be scheduled by job ID even when a public preview URL is not exposed.'
    : 'Start a generation from the left panel, or open this workspace with an existing job ID.';
  wrap.append(title, copy);
  root.replaceChildren(wrap);
}

function renderProgress() {
  const job = state.activeJob;
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  byId<HTMLSpanElement>('progress-label').textContent = job.jobId
    ? `${job.status} - ${job.jobId}`
    : 'No active job';
  byId<HTMLSpanElement>('progress-value').textContent = `${progress}%`;
  byId<HTMLDivElement>('progress-fill').style.width = `${progress}%`;
}

function renderMeta() {
  const job = state.activeJob;
  const rows: Array<[string, string]> = [
    ['Job ID', job.jobId ?? '-'],
    ['Model', job.model || state.model],
    ['Credits', job.credits === null ? '-' : String(job.credits)],
    ['Created', job.createdAt ?? '-'],
  ];
  byId<HTMLDivElement>('job-meta').replaceChildren(
    ...rows.map(([label, value]) => {
      const box = document.createElement('div');
      box.className = 'metric';
      const labelNode = document.createElement('div');
      labelNode.className = 'label';
      labelNode.textContent = label;
      const valueNode = document.createElement('div');
      valueNode.className = 'value';
      valueNode.title = value;
      valueNode.textContent = value;
      box.append(labelNode, valueNode);
      return box;
    })
  );
}

function renderButtonStates() {
  byId<HTMLButtonElement>('generate').disabled =
    state.busy || !canWrite() || state.prompt.trim().length === 0;
  byId<HTMLButtonElement>('generate').textContent = state.busy ? 'Working...' : 'Generate';
  byId<HTMLButtonElement>('poll').disabled = state.busy || !state.activeJob.jobId;
  byId<HTMLButtonElement>('auto-poll').disabled = !state.activeJob.jobId;
  byId<HTMLButtonElement>('auto-poll').textContent = state.polling ? 'Auto-poll on' : 'Auto-poll off';
  byId<HTMLButtonElement>('schedule').disabled =
    state.busy || !canDistribute() || !isSchedulable() || state.caption.trim().length === 0;
}

async function startGeneration() {
  if (!canWrite()) {
    showToast('This account does not have write scope.', 'error');
    return;
  }
  if (state.prompt.trim().length === 0) {
    showToast('Prompt cannot be empty.', 'error');
    return;
  }

  state.busy = true;
  state.activeJob = { ...emptyJob(state.type), status: 'starting', model: state.model };
  renderAll();

  try {
    const result = await app.callServerTool({
      name: state.type === 'image' ? 'generate_image' : 'generate_video',
      arguments: generationArgs(),
    });
    if (isScopeDenied(result)) {
      showToast('Permission denied. This account needs mcp:write.', 'error');
      return;
    }
    if (result.isError) {
      showToast(firstText(result) || 'Generation failed to start.', 'error');
      return;
    }
    const data = parseEnvelope(firstText(result));
    const jobId = stringOr(data.jobId, stringOr(data.asyncJobId, stringOr(data.taskId, null)));
    if (!jobId) {
      showToast('Generation started but no job ID was returned.', 'error');
      return;
    }
    state.activeJob = {
      ...emptyJob(state.type),
      jobId,
      type: state.type,
      model: stringValue(data.model, state.model),
      status: 'queued',
      progress: 1,
      credits: numberOrNull(data.creditsDeducted),
      createdAt: new Date().toISOString(),
    };
    showToast(`Generation started: ${jobId}`);
    startAutoPoll();
  } catch (err) {
    showToast(`Generation failed: ${(err as Error).message}`, 'error');
  } finally {
    state.busy = false;
    renderAll();
  }
}

function generationArgs(): Record<string, unknown> {
  if (state.type === 'image') {
    return {
      prompt: state.prompt,
      model: state.model,
      aspect_ratio: state.aspectRatio,
      response_format: 'json',
    };
  }
  return {
    prompt: state.prompt,
    model: state.model,
    aspect_ratio: state.aspectRatio,
    duration: state.duration,
    response_format: 'json',
  };
}

async function pollStatus() {
  if (!state.activeJob.jobId) return;
  state.busy = true;
  renderAll();
  try {
    const result = await app.callServerTool({
      name: 'check_status',
      arguments: { job_id: state.activeJob.jobId, response_format: 'json' },
    });
    if (isScopeDenied(result)) {
      showToast('Permission denied. This account needs read scope.', 'error');
      stopAutoPoll();
      return;
    }
    if (result.isError) {
      showToast(firstText(result) || 'Status check failed.', 'error');
      stopAutoPoll();
      return;
    }
    const data = parseEnvelope(firstText(result));
    applyJobStatus(data);
    const done = ['completed', 'succeeded', 'failed', 'error'].includes(
      state.activeJob.status.toLowerCase()
    );
    if (done) stopAutoPoll();
  } catch (err) {
    showToast(`Status check failed: ${(err as Error).message}`, 'error');
  } finally {
    state.busy = false;
    renderAll();
  }
}

function applyJobStatus(data: Record<string, unknown>) {
  const status = stringValue(data.status, state.activeJob.status);
  const rawResultUrl = stringOr(data.resultUrl, stringOr(data.result_url, null));
  const resultUrl = rawResultUrl?.startsWith('http') ? rawResultUrl : null;
  const allUrls = Array.isArray(data.all_urls)
    ? data.all_urls.filter((v): v is string => typeof v === 'string')
    : [];
  state.activeJob = {
    ...state.activeJob,
    jobId: stringOr(data.jobId, stringOr(data.id, state.activeJob.jobId)),
    type: state.type,
    model: stringValue(data.model, state.activeJob.model || state.model),
    status,
    progress: Number(data.progress ?? state.activeJob.progress ?? 0),
    resultUrl,
    r2Key: stringOr(
      data.r2_key,
      rawResultUrl?.startsWith('http') ? state.activeJob.r2Key : rawResultUrl
    ),
    allUrls,
    error: stringOr(data.error, stringOr(data.error_message, null)),
    credits: numberOrNull(data.credits ?? data.credits_cost ?? state.activeJob.credits),
    createdAt: stringOr(data.createdAt, stringOr(data.created_at, state.activeJob.createdAt)),
  };
  if (state.activeJob.error) {
    showToast(state.activeJob.error, 'error');
  }
  const finalStatus = state.activeJob.status.toLowerCase();
  if (
    (finalStatus === 'completed' || finalStatus === 'succeeded') &&
    (state.activeJob.resultUrl || state.activeJob.r2Key || state.activeJob.allUrls.length > 0)
  ) {
    pushWorkspaceContext(
      `In the generation workspace, a ${state.activeJob.type} generation (job ${state.activeJob.jobId}, model ${
        state.activeJob.model || state.model
      }) completed and is ready to review or schedule.`
    );
  }
}

async function scheduleResult() {
  if (!canDistribute()) {
    showToast('This account does not have distribute scope.', 'error');
    return;
  }
  if (!isSchedulable() || !state.activeJob.jobId) {
    showToast('Wait for a completed generation before scheduling.', 'error');
    return;
  }
  if (!state.caption.trim()) {
    showToast('Caption cannot be empty.', 'error');
    return;
  }

  state.busy = true;
  renderAll();
  try {
    const connected = await platformConnected(state.platform);
    if (!connected) {
      showToast(`No active ${state.platform} connection. Connect it in Social Neuron settings.`, 'error');
      return;
    }

    const scheduleAt = state.scheduleAt ? new Date(state.scheduleAt).toISOString() : undefined;
    const result = await app.callServerTool({
      name: 'schedule_post',
      arguments: {
        job_id: state.activeJob.jobId,
        caption: state.caption,
        platforms: [state.platform],
        media_type: state.type === 'image' ? 'IMAGE' : 'VIDEO',
        schedule_at: scheduleAt,
      },
    });

    if (isScopeDenied(result)) {
      showToast('Permission denied. This account needs mcp:distribute.', 'error');
      return;
    }
    if (result.isError) {
      showToast(firstText(result) || 'Schedule failed.', 'error');
      return;
    }
    showToast(`Scheduled ${state.type} for ${state.platform}.`);
    pushWorkspaceContext(
      `In the generation workspace, the user scheduled the generated ${state.type} (job ${
        state.activeJob.jobId
      }) to ${state.platform}${scheduleAt ? ` for ${scheduleAt}` : ''}.`
    );
  } catch (err) {
    showToast(`Schedule failed: ${(err as Error).message}`, 'error');
  } finally {
    state.busy = false;
    renderAll();
  }
}

async function platformConnected(platform: string): Promise<boolean> {
  const result = await app.callServerTool({
    name: 'list_connected_accounts',
    arguments: { response_format: 'json' },
  });
  if (isScopeDenied(result)) return false;
  if (result.isError) {
    showToast(firstText(result) || 'Could not check connected accounts.', 'error');
    return false;
  }
  const data = parseEnvelope(firstText(result));
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  return accounts.some((account) => {
    if (!account || typeof account !== 'object') return false;
    const maybePlatform = (account as Record<string, unknown>).platform;
    return typeof maybePlatform === 'string' && maybePlatform.toLowerCase() === platform;
  });
}

function isSchedulable(): boolean {
  const status = state.activeJob.status.toLowerCase();
  return Boolean(
    state.activeJob.jobId &&
      (status === 'completed' || status === 'succeeded') &&
      (state.activeJob.resultUrl || state.activeJob.r2Key || state.activeJob.allUrls.length > 0)
  );
}

function toggleAutoPoll() {
  if (state.polling) {
    stopAutoPoll();
  } else {
    startAutoPoll();
  }
  renderAll();
}

function startAutoPoll() {
  if (!state.activeJob.jobId || state.polling) return;
  state.polling = true;
  pollTimer = window.setInterval(() => {
    void pollStatus();
  }, state.type === 'image' ? 7000 : 12000);
  renderAll();
}

function stopAutoPoll() {
  state.polling = false;
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function clearJob() {
  stopAutoPoll();
  state.activeJob = emptyJob(state.type);
  renderAll();
}

function firstText(result: ToolResult): string {
  return result.content?.find((c) => c.type === 'text')?.text ?? '';
}

function parseEnvelope(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as { data?: Record<string, unknown> } | Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && 'data' in parsed && parsed.data) {
      return parsed.data as Record<string, unknown>;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringOr(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

let toastTimer: number | null = null;
function showToast(message: string, kind: 'info' | 'error' = 'info') {
  const toast = byId<HTMLDivElement>('toast');
  toast.textContent = message;
  toast.classList.toggle('error', kind === 'error');
  toast.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  toast.classList.add('show');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 4000);
}
