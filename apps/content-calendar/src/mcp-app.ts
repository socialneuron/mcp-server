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

const state: { posts: ScheduledPost[]; scopes: string[]; canSchedule: boolean } = {
  posts: [],
  scopes: [],
  canSchedule: false,
};

const app = new App({ name: 'Content Calendar', version: '0.2.0' });
app.connect();

app.ontoolresult = (result) => {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '{}';
  try {
    const payload = JSON.parse(text) as CalendarPayload;
    state.posts = payload.posts ?? [];
    state.scopes = payload.scopes ?? [];
    state.canSchedule = hasScope(state.scopes, 'mcp:distribute');
    renderCalendar();
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
  card.append(el('div', 'post-platform', post.platform));
  const label = (post.title ?? post.external_post_id ?? post.id).slice(0, 80);
  card.append(el('div', undefined, label));
  return card;
}

function renderSlot(date: string, posts: ScheduledPost[]): HTMLElement {
  const slot = el('div', 'slot');
  slot.dataset.date = date;
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

  if (state.posts.length === 0) {
    subtitle.textContent = 'No scheduled posts this week.';
    root.replaceChildren(el('div', 'empty-state', "When you schedule posts, they'll appear here."));
    return;
  }

  subtitle.textContent = `${state.posts.length} scheduled post${state.posts.length === 1 ? '' : 's'}`;

  const dates = getWeekDates();
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const postsByDate = new Map<string, ScheduledPost[]>();
  for (const post of state.posts) {
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

// ─── Drag-drop reschedule ──────────────────────────────────────────────

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
  if (oldDate === newDate) return; // no-op

  // Build new ISO timestamp: keep original time-of-day, swap the date.
  const time = oldScheduledAt && oldScheduledAt.includes('T')
    ? oldScheduledAt.split('T')[1]
    : '12:00:00.000Z';
  const newScheduledAt = `${newDate}T${time}`;

  // Optimistic: update local state and re-render before the round-trip.
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

// ─── Toast / error UI ──────────────────────────────────────────────

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
