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
} = {
  posts: [],
  scopes: [],
  canSchedule: false,
  platformFilter: null,
  selectedPostId: null,
  suggestedSlot: null,
};

const app = new App({ name: 'Content Calendar', version: '0.3.0' });
app.connect();

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
  suggest.disabled = !state.canSchedule || !state.platformFilter;
  if (suggest.disabled) {
    suggest.title = !state.canSchedule
      ? 'Upgrade to schedule posts'
      : 'Pick a platform first';
  }
  suggest.addEventListener('click', () => {
    if (!state.platformFilter) return;
    void suggestNextSlot(state.platformFilter);
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

  const heading = el('h2', undefined, post.title ?? 'Post');
  (heading.style as CSSStyleDeclaration).fontSize = '15px';
  (heading.style as CSSStyleDeclaration).margin = '4px 32px 16px 0';
  (heading.style as CSSStyleDeclaration).fontWeight = '600';

  const fields: Array<[string, string]> = [
    ['Platform', post.platform],
    ['Status', post.status],
    ['Scheduled for', post.scheduled_at ?? post.published_at ?? '—'],
    ['Created', post.created_at],
    ['External ID', post.external_post_id ?? '—'],
    ['Internal ID', post.id],
  ];

  const rows = fields.map(([label, value]) => {
    const row = el('div', 'drilldown-row');
    row.append(el('div', 'label', label));
    if (label === 'Status') {
      const pill = el('span', `status-pill ${value.toLowerCase()}`, value);
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
}

// ─── Suggest next slot ────────────────────────────────────────────────

async function suggestNextSlot(platform: string) {
  try {
    const result = await app.callServerTool({
      name: 'find_next_slots',
      arguments: {
        platforms: [platform],
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
    if (slots.length === 0) {
      showError(`No available slots found for ${platform} this week.`);
      return;
    }

    const slot = slots[0];
    const date = slot.datetime.split('T')[0];
    const dates = getWeekDates();
    if (!dates.includes(date)) {
      showToast(`Next ${platform} slot: ${slot.datetime} (outside current week view).`);
      return;
    }

    state.suggestedSlot = { date, platform };
    renderCalendar();
    showToast(`Suggested ${platform} slot: ${slot.datetime}`);
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
  node.classList.add('show');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('show'), 4000);
}

function showError(msg: string) {
  showToast(msg, 'error');
  const subtitle = document.getElementById('subtitle');
  if (subtitle) subtitle.textContent = msg;
}

function renderAll() {
  renderToolbar();
  renderCalendar();
  renderDrilldown();
}
