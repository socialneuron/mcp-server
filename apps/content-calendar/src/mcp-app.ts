import { App } from '@modelcontextprotocol/ext-apps';

interface ScheduledPost {
  id: string;
  platform: string;
  status: string;
  title: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  external_post_id: string | null;
  created_at: string;
}

interface CalendarPayload {
  posts: ScheduledPost[];
  scopes: string[];
}

interface PostingSlot {
  platform: string;
  datetime: string;
  day_of_week: number;
  hour: number;
  engagement_score?: number;
  conflict?: boolean;
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

const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  twitter: 280,
  bluesky: 300,
  threads: 500,
  instagram: 2200,
  tiktok: 2200,
  linkedin: 3000,
  youtube: 5000,
  facebook: 63206,
};

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

function hasScope(userScopes: string[], required: string): boolean {
  if (userScopes.includes(required)) return true;
  for (const userScope of userScopes) {
    const children = SCOPE_HIERARCHY[userScope];
    if (children?.includes(required)) return true;
  }
  return false;
}

// Scope-denied responses arrive as success-shaped tool calls with a content
// prefix. See `superpowers/specs/2026-04-24-mcp-app-content-calendar.md` Auth flow.
function isScopeDenied(result: { content?: Array<{ type: string; text?: string }> }): boolean {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  return text.startsWith('Permission denied:');
}

const state: {
  posts: ScheduledPost[];
  scopes: string[];
  canSchedule: boolean;
  platformFilter: string | null;
  selectedPostId: string | null;
  suggestedSlot: { date: string; platform: string } | null;
  modal: {
    open: boolean;
    date: string;
    platform: string;
    caption: string;
    time: string;
    submitting: boolean;
    error: string | null;
  };
} = {
  posts: [],
  scopes: [],
  canSchedule: false,
  platformFilter: null,
  selectedPostId: null,
  suggestedSlot: null,
  modal: {
    open: false,
    date: '',
    platform: 'instagram',
    caption: '',
    time: '12:00',
    submitting: false,
    error: null,
  },
};

const app = new App({ name: 'Content Calendar', version: '0.5.0' });
app.connect();

// Global Escape key — close whichever overlay is open (modal first, then drilldown).
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (state.modal.open && !state.modal.submitting) {
    closeQuickCreate();
    return;
  }
  if (state.selectedPostId !== null) {
    state.selectedPostId = null;
    renderDrilldown();
  }
});

app.ontoolresult = (result) => {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}';
  try {
    const payload = JSON.parse(text) as CalendarPayload;
    state.posts = payload.posts ?? [];
    state.scopes = payload.scopes ?? [];
    state.canSchedule = hasScope(state.scopes, 'mcp:distribute');
    renderAll();
  } catch (err) {
    showError(`Failed to parse calendar payload: ${(err as Error).message}`);
  }
};

function getWeekDates(): string[] {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + (day === 0 ? -6 : 1));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d.toISOString().split('T')[0];
  });
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function visiblePosts(): ScheduledPost[] {
  if (!state.platformFilter) return state.posts;
  return state.posts.filter((p) => p.platform === state.platformFilter);
}

// ─── Toolbar (filter pills + suggest button) ──────────────────────────

function renderToolbar() {
  const bar = document.getElementById('toolbar');
  if (!bar) return;

  const pills = el('div', 'filter-pills');
  const allPill = el('div', `pill${state.platformFilter === null ? ' active' : ''}`, 'All');
  allPill.addEventListener('click', () => {
    state.platformFilter = null;
    state.suggestedSlot = null;
    renderAll();
  });
  pills.append(allPill);

  // Surface only the platforms with at least one post (avoid pill noise).
  const presentPlatforms = new Set(state.posts.map((p) => p.platform.toLowerCase()));
  for (const platform of PLATFORMS) {
    if (!presentPlatforms.has(platform)) continue;
    const pill = el('div', `pill${state.platformFilter === platform ? ' active' : ''}`, platform);
    pill.addEventListener('click', () => {
      state.platformFilter = state.platformFilter === platform ? null : platform;
      state.suggestedSlot = null;
      renderAll();
    });
    pills.append(pill);
  }

  const suggest = document.createElement('button');
  suggest.className = 'suggest-btn';
  suggest.textContent = 'Suggest next slot';
  // Need at least one platform to suggest for. If a filter is set, use it; otherwise
  // use any platforms that have at least one post (so the button stays useful in "All").
  const candidatePlatforms = state.platformFilter
    ? [state.platformFilter]
    : Array.from(presentPlatforms);
  suggest.disabled = !state.canSchedule || candidatePlatforms.length === 0;
  if (suggest.disabled) {
    suggest.title = !state.canSchedule
      ? 'Upgrade to schedule posts'
      : 'No platforms with posts to suggest for';
  }
  suggest.addEventListener('click', () => {
    if (candidatePlatforms.length === 0) return;
    void suggestNextSlot(candidatePlatforms);
  });

  bar.replaceChildren(pills, suggest);
}

// ─── Calendar grid ────────────────────────────────────────────────────

function renderUpgradeBanner(): HTMLElement | null {
  if (state.canSchedule) return null;
  const wrap = el('div', 'upgrade-banner');
  wrap.append(document.createTextNode('Read-only — upgrade your plan to drag-drop reschedule. '));
  const link = document.createElement('a');
  link.href = 'https://socialneuron.com/pricing';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'View pricing →';
  wrap.append(link);
  return wrap;
}

function renderPostCard(post: ScheduledPost): HTMLElement {
  const card = el('div', `post-card${state.canSchedule ? '' : ' disabled'}`);
  card.dataset.postId = post.id;
  if (state.canSchedule) {
    card.draggable = true;
    card.addEventListener('dragstart', onCardDragStart);
    card.addEventListener('dragend', onCardDragEnd);
  }
  card.addEventListener('click', () => {
    state.selectedPostId = post.id;
    renderDrilldown();
  });
  card.append(el('div', 'post-platform', post.platform));
  const label = (post.title ?? post.external_post_id ?? post.id).slice(0, 80);
  card.append(el('div', undefined, label));
  return card;
}

function renderSlot(date: string, posts: ScheduledPost[]): HTMLElement {
  const slot = el('div', 'slot');
  slot.dataset.date = date;
  if (state.suggestedSlot && state.suggestedSlot.date === date) {
    slot.classList.add('suggested');
  }
  if (state.canSchedule) {
    slot.addEventListener('dragover', onSlotDragOver);
    slot.addEventListener('dragleave', onSlotDragLeave);
    slot.addEventListener('drop', onSlotDrop);
  }
  for (const post of posts) {
    slot.append(renderPostCard(post));
  }
  if (state.canSchedule) {
    const addBtn = document.createElement('button');
    addBtn.className = 'add-btn';
    addBtn.textContent = '+ Post';
    addBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openQuickCreate(date);
    });
    slot.append(addBtn);
  }
  return slot;
}

function renderCalendar() {
  const root = document.getElementById('root');
  const subtitle = document.getElementById('subtitle');
  const banner = document.getElementById('upgrade-banner-slot');
  if (!root || !subtitle || !banner) return;

  const upgrade = renderUpgradeBanner();
  banner.replaceChildren(...(upgrade ? [upgrade] : []));

  const visible = visiblePosts();

  if (visible.length === 0) {
    subtitle.textContent = state.platformFilter
      ? `No ${state.platformFilter} posts this week.`
      : 'No scheduled posts this week.';
    root.replaceChildren(el('div', 'empty-state', "When you schedule posts, they'll appear here."));
    return;
  }

  subtitle.textContent =
    state.platformFilter !== null
      ? `${visible.length} ${state.platformFilter} post${visible.length === 1 ? '' : 's'}`
      : `${visible.length} scheduled post${visible.length === 1 ? '' : 's'}`;

  const dates = getWeekDates();
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const postsByDate = new Map<string, ScheduledPost[]>();
  for (const post of visible) {
    const ts = post.scheduled_at ?? post.published_at ?? post.created_at;
    if (!ts) continue;
    const date = ts.split('T')[0];
    if (!postsByDate.has(date)) postsByDate.set(date, []);
    postsByDate.get(date)!.push(post);
  }

  const grid = el('div', 'week-grid');
  grid.append(el('div', 'header'));
  for (let i = 0; i < 7; i++) {
    grid.append(el('div', 'header', `${dayLabels[i]} ${dates[i].slice(5)}`));
  }
  grid.append(el('div', 'hour-label', 'All day'));
  for (const date of dates) {
    grid.append(renderSlot(date, postsByDate.get(date) ?? []));
  }
  root.replaceChildren(grid);
}

// ─── Drilldown side panel ─────────────────────────────────────────────

function renderDrilldown() {
  const panel = document.getElementById('drilldown');
  if (!panel) return;

  if (!state.selectedPostId) {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    panel.replaceChildren();
    return;
  }

  const post = state.posts.find((p) => p.id === state.selectedPostId);
  if (!post) {
    state.selectedPostId = null;
    panel.classList.remove('open');
    return;
  }

  const close = document.createElement('button');
  close.className = 'drilldown-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', () => {
    state.selectedPostId = null;
    renderDrilldown();
  });

  const heading = el('h2', 'drilldown-heading', post.title ?? 'Post');

  const fields: Array<[string, string]> = [
    ['Platform', post.platform],
    ['Status', post.status],
    ['Scheduled for', post.scheduled_at ?? post.published_at ?? '—'],
    ['Created', post.created_at],
    ['External ID', post.external_post_id ?? '—'],
    ['Internal ID', post.id],
  ];

  const KNOWN_STATUSES = new Set(['scheduled', 'published', 'draft', 'failed']);

  const rows = fields.map(([label, value]) => {
    const row = el('div', 'drilldown-row');
    row.append(el('div', 'label', label));
    if (label === 'Status') {
      const statusClass = KNOWN_STATUSES.has(value.toLowerCase()) ? value.toLowerCase() : 'draft';
      const pill = el('span', `status-pill ${statusClass}`, value);
      const wrap = el('div', 'value');
      wrap.append(pill);
      row.append(wrap);
    } else {
      row.append(el('div', 'value', value));
    }
    return row;
  });

  panel.replaceChildren(close, heading, ...rows);
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  // Move focus into the panel so screen readers announce it and Escape works
  // even if the user dragged-and-dropped just before clicking a card.
  close.focus();
}

// ─── Suggest next slot ────────────────────────────────────────────────

async function suggestNextSlot(platforms: string[]) {
  try {
    const result = await app.callServerTool({
      name: 'find_next_slots',
      arguments: {
        platforms,
        count: 1,
        response_format: 'json',
      },
    });

    if (isScopeDenied(result)) {
      showError("You don't have permission to find slots. Upgrade your plan to schedule posts.");
      return;
    }

    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    const parsed = (() => {
      try {
        return JSON.parse(text) as { data?: { slots?: PostingSlot[] }; slots?: PostingSlot[] };
      } catch {
        return null;
      }
    })();

    const slots: PostingSlot[] = parsed?.data?.slots ?? parsed?.slots ?? [];
    const label = platforms.length === 1 ? platforms[0] : 'any platform';
    if (slots.length === 0) {
      showError(`No available slots found for ${label} this week.`);
      return;
    }

    const slot = slots[0];
    const date = slot.datetime.split('T')[0];
    const dates = getWeekDates();
    if (!dates.includes(date)) {
      showToast(`Next ${slot.platform} slot: ${slot.datetime} (outside current week view).`);
      return;
    }

    state.suggestedSlot = { date, platform: slot.platform };
    renderCalendar();
    showToast(`Suggested ${slot.platform} slot: ${slot.datetime}`);
  } catch (err) {
    showError(`Failed to find slots: ${(err as Error).message}`);
  }
}

// ─── Drag-drop reschedule ─────────────────────────────────────────────

let draggingPostId: string | null = null;

function onCardDragStart(ev: DragEvent) {
  const card = ev.currentTarget as HTMLElement;
  const postId = card.dataset.postId;
  if (!postId || !ev.dataTransfer) return;
  draggingPostId = postId;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', postId);
  card.classList.add('dragging');
}

function onCardDragEnd(ev: DragEvent) {
  const card = ev.currentTarget as HTMLElement;
  card.classList.remove('dragging');
  draggingPostId = null;
}

function onSlotDragOver(ev: DragEvent) {
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
  (ev.currentTarget as HTMLElement).classList.add('drop-target');
}

function onSlotDragLeave(ev: DragEvent) {
  (ev.currentTarget as HTMLElement).classList.remove('drop-target');
}

async function onSlotDrop(ev: DragEvent) {
  ev.preventDefault();
  const slot = ev.currentTarget as HTMLElement;
  slot.classList.remove('drop-target');
  const newDate = slot.dataset.date;
  const postId = ev.dataTransfer?.getData('text/plain') ?? draggingPostId;
  if (!postId || !newDate) return;

  const post = state.posts.find((p) => p.id === postId);
  if (!post) return;

  const oldScheduledAt = post.scheduled_at ?? post.published_at ?? post.created_at;
  const oldDate = oldScheduledAt?.split('T')[0];
  if (oldDate === newDate) return;

  const time = oldScheduledAt && oldScheduledAt.includes('T')
    ? oldScheduledAt.split('T')[1]
    : '12:00:00.000Z';
  const newScheduledAt = `${newDate}T${time}`;

  post.scheduled_at = newScheduledAt;
  renderCalendar();

  try {
    const result = await app.callServerTool({
      name: 'schedule_post',
      arguments: {
        post_id: postId,
        update: true,
        schedule_at: newScheduledAt,
      },
    });
    if (isScopeDenied(result)) {
      revertPost(postId, oldScheduledAt);
      showError("You don't have permission to reschedule. Upgrade your plan to schedule posts.");
      return;
    }
    if ((result as { isError?: boolean }).isError) {
      const text = result.content?.find((c) => c.type === 'text')?.text ?? 'Reschedule failed.';
      revertPost(postId, oldScheduledAt);
      showError(text);
      return;
    }
    showToast(`Rescheduled to ${newDate}.`);
  } catch (err) {
    revertPost(postId, oldScheduledAt);
    showError(`Reschedule failed: ${(err as Error).message}`);
  }
}

function revertPost(postId: string, oldScheduledAt: string | null) {
  const post = state.posts.find((p) => p.id === postId);
  if (!post) return;
  post.scheduled_at = oldScheduledAt;
  renderCalendar();
}

// ─── Toast / error UI ─────────────────────────────────────────────────

let toastTimer: number | null = null;

function showToast(msg: string, kind: 'info' | 'error' = 'info') {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = msg;
  node.classList.toggle('error', kind === 'error');
  // Errors should be announced immediately; info toasts can wait for the next
  // screen-reader pause. See WAI-ARIA aria-live spec.
  node.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  node.classList.add('show');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('show'), 4000);
}

function showError(msg: string) {
  showToast(msg, 'error');
  const subtitle = document.getElementById('subtitle');
  if (subtitle) subtitle.textContent = msg;
}

// ─── Quick-create modal ───────────────────────────────────────────────

function openQuickCreate(date: string) {
  state.modal = {
    open: true,
    date,
    platform: state.platformFilter ?? 'instagram',
    caption: '',
    time: '12:00',
    submitting: false,
    error: null,
  };
  renderModal();
}

function closeQuickCreate() {
  state.modal = { ...state.modal, open: false, error: null };
  renderModal();
}

// Backdrop click handler — closes only when the click is on the backdrop itself,
// not bubbled up from inside the modal. Wired once on first render.
let backdropHandlerAttached = false;
function ensureBackdropHandler() {
  if (backdropHandlerAttached) return;
  const backdrop = document.getElementById('modal-backdrop');
  if (!backdrop) return;
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop && !state.modal.submitting) {
      closeQuickCreate();
    }
  });
  backdropHandlerAttached = true;
}

function renderModal() {
  const backdrop = document.getElementById('modal-backdrop');
  const modal = document.getElementById('modal');
  if (!backdrop || !modal) return;

  ensureBackdropHandler();

  if (!state.modal.open) {
    backdrop.classList.remove('open');
    backdrop.setAttribute('aria-hidden', 'true');
    modal.replaceChildren();
    return;
  }

  const headingId = 'modal-heading';
  modal.setAttribute('aria-labelledby', headingId);
  const heading = el('h2', undefined, `Schedule post for ${state.modal.date}`);
  heading.id = headingId;

  // Platform select
  const platformRow = el('div', 'modal-row');
  platformRow.append(el('label', undefined, 'Platform'));
  const platformSelect = document.createElement('select');
  for (const p of PLATFORMS) {
    const option = document.createElement('option');
    option.value = p;
    option.textContent = p;
    if (p === state.modal.platform) option.selected = true;
    platformSelect.append(option);
  }
  platformSelect.addEventListener('change', () => {
    state.modal.platform = platformSelect.value;
    renderModal();
  });
  platformRow.append(platformSelect);

  // Caption textarea
  const captionRow = el('div', 'modal-row');
  captionRow.append(el('label', undefined, 'Caption'));
  const captionArea = document.createElement('textarea');
  captionArea.value = state.modal.caption;
  captionArea.placeholder = 'What do you want to post?';
  captionArea.addEventListener('input', () => {
    state.modal.caption = captionArea.value;
    updateCharCount();
  });
  captionRow.append(captionArea);

  const limit = PLATFORM_CHAR_LIMITS[state.modal.platform] ?? 5000;
  const charCount = el('div', 'char-count', `${state.modal.caption.length} / ${limit}`);
  charCount.id = 'modal-char-count';
  if (state.modal.caption.length > limit) charCount.classList.add('over');
  captionRow.append(charCount);

  // Time picker
  const timeRow = el('div', 'modal-row');
  timeRow.append(el('label', undefined, 'Time (24h, local)'));
  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.value = state.modal.time;
  timeInput.addEventListener('input', () => {
    state.modal.time = timeInput.value;
  });
  timeRow.append(timeInput);

  // Error message
  const errorWrap = el('div');
  if (state.modal.error) {
    errorWrap.append(el('div', 'error-msg', state.modal.error));
  }

  // Actions
  const actions = el('div', 'modal-actions');
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.disabled = state.modal.submitting;
  cancelBtn.addEventListener('click', closeQuickCreate);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary';
  saveBtn.textContent = state.modal.submitting ? 'Scheduling…' : 'Schedule';
  saveBtn.disabled =
    state.modal.submitting ||
    state.modal.caption.trim().length === 0 ||
    state.modal.caption.length > limit;
  saveBtn.addEventListener('click', () => {
    void submitQuickCreate();
  });
  actions.append(cancelBtn, saveBtn);

  modal.replaceChildren(heading, platformRow, captionRow, timeRow, errorWrap, actions);
  backdrop.classList.add('open');
  backdrop.setAttribute('aria-hidden', 'false');
  // Auto-focus the caption on open so the user can start typing immediately.
  // Use rAF to ensure the textarea exists in the DOM before focusing.
  if (!state.modal.submitting) {
    requestAnimationFrame(() => captionArea.focus());
  }
}

function updateCharCount() {
  const node = document.getElementById('modal-char-count');
  if (!node) return;
  const limit = PLATFORM_CHAR_LIMITS[state.modal.platform] ?? 5000;
  node.textContent = `${state.modal.caption.length} / ${limit}`;
  node.classList.toggle('over', state.modal.caption.length > limit);
}

async function submitQuickCreate() {
  const limit = PLATFORM_CHAR_LIMITS[state.modal.platform] ?? 5000;
  if (state.modal.caption.trim().length === 0) {
    state.modal.error = 'Caption cannot be empty.';
    renderModal();
    return;
  }
  if (state.modal.caption.length > limit) {
    state.modal.error = `Caption exceeds ${state.modal.platform} limit (${limit} chars).`;
    renderModal();
    return;
  }

  // Build ISO timestamp from date + time. Validate it's not in the past.
  const scheduleAt = `${state.modal.date}T${state.modal.time}:00`;
  if (new Date(scheduleAt).getTime() < Date.now()) {
    state.modal.error = 'Schedule time must be in the future.';
    renderModal();
    return;
  }

  state.modal.submitting = true;
  state.modal.error = null;
  renderModal();

  try {
    const result = await app.callServerTool({
      name: 'schedule_post',
      arguments: {
        caption: state.modal.caption,
        platforms: [state.modal.platform],
        schedule_at: scheduleAt,
      },
    });

    if (isScopeDenied(result)) {
      state.modal.submitting = false;
      state.modal.error =
        "You don't have permission to schedule. Upgrade your plan at socialneuron.com/pricing.";
      renderModal();
      return;
    }
    if ((result as { isError?: boolean }).isError) {
      const text =
        result.content?.find((c) => c.type === 'text')?.text ?? 'Failed to schedule post.';
      state.modal.submitting = false;
      state.modal.error = text;
      renderModal();
      return;
    }

    closeQuickCreate();
    showToast(`Scheduled for ${state.modal.date} ${state.modal.time}.`);
    void refreshCalendar();
  } catch (err) {
    state.modal.submitting = false;
    state.modal.error = `Failed: ${(err as Error).message}`;
    renderModal();
  }
}

async function refreshCalendar() {
  try {
    const result = await app.callServerTool({
      name: 'open_content_calendar',
      arguments: {},
    });
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}';
    const payload = JSON.parse(text) as CalendarPayload;
    state.posts = payload.posts ?? [];
    state.scopes = payload.scopes ?? state.scopes;
    state.canSchedule = hasScope(state.scopes, 'mcp:distribute');
    renderAll();
  } catch (err) {
    showError(`Failed to refresh calendar: ${(err as Error).message}`);
  }
}

function renderAll() {
  renderToolbar();
  renderCalendar();
  renderDrilldown();
  renderModal();
}
