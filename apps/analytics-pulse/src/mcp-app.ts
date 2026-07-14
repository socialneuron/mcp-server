import { App } from '@modelcontextprotocol/ext-apps';

interface AnalyticsPost {
  platform: string;
  title: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  engagement_rate: number;
  captured_at: string;
  published_at: string | null;
}

interface AnalyticsPayload {
  project_id: string;
  platform: string | null;
  days: number;
  summary: { views: number; engagement: number; engagement_rate: number; posts: number };
  platform_totals: Array<{ platform: string; views: number; engagement: number; posts: number }>;
  posts: AnalyticsPost[];
}

function payloadFromResult(result: {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): AnalyticsPayload | null {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    const payload = result.structuredContent as Partial<AnalyticsPayload>;
    if (
      typeof payload.project_id === 'string' &&
      typeof payload.days === 'number' &&
      payload.summary &&
      Array.isArray(payload.posts) &&
      Array.isArray(payload.platform_totals)
    ) return payload as AnalyticsPayload;
  }
  const text = result.content?.find((block) => block.type === 'text')?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<AnalyticsPayload>;
    return typeof parsed.project_id === 'string' && Array.isArray(parsed.posts)
      ? (parsed as AnalyticsPayload)
      : null;
  } catch {
    return null;
  }
}

const state: { payload: AnalyticsPayload | null; loading: boolean } = {
  payload: null,
  loading: false,
};

const app = new App({ name: 'Analytics Pulse', version: '1.0.0' });
app.connect();

app.ontoolresult = (result) => {
  const payload = payloadFromResult(result);
  if (!payload) return;
  state.payload = payload;
  state.loading = false;
  render();
};

const nf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const percent = (value: number) => `${value.toFixed(value >= 10 ? 0 : 2)}%`;

function node(tag: string, className?: string, text?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function reload(next?: { days?: number; platform?: string }) {
  if (!state.payload || state.loading) return;
  state.loading = true;
  setControlsDisabled(true);
  const days = next?.days ?? state.payload.days;
  const platform = next?.platform !== undefined ? next.platform : (state.payload.platform ?? '');
  try {
    const result = await app.callServerTool({
      name: 'open_analytics_pulse',
      arguments: {
        project_id: state.payload.project_id,
        days,
        ...(platform ? { platform } : {}),
      },
    });
    const payload = payloadFromResult(result);
    if (!payload || result.isError) throw new Error('invalid_result');
    state.payload = payload;
    state.loading = false;
    render();
  } catch {
    state.loading = false;
    setControlsDisabled(false);
    const subtitle = document.getElementById('subtitle');
    if (subtitle) subtitle.textContent = 'Analytics could not refresh. Please retry.';
  }
}

function setControlsDisabled(disabled: boolean) {
  document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')
    .forEach((control) => { control.disabled = disabled; });
}

function render() {
  const root = document.getElementById('root');
  const subtitle = document.getElementById('subtitle');
  const payload = state.payload;
  if (!root || !subtitle || !payload) return;
  subtitle.textContent = `${payload.days}-day project performance${payload.platform ? ` · ${payload.platform}` : ''}`;

  const kpis = node('section', 'kpis');
  const metrics: Array<[string, string]> = [
    ['Views', nf.format(payload.summary.views)],
    ['Engagements', nf.format(payload.summary.engagement)],
    ['Engagement rate', percent(payload.summary.engagement_rate)],
    ['Measured posts', nf.format(payload.summary.posts)],
  ];
  for (const [label, value] of metrics) {
    const card = node('div', 'card');
    card.append(node('div', 'label', label), node('div', 'value', value));
    kpis.append(card);
  }

  if (payload.posts.length === 0) {
    root.replaceChildren(kpis, node('div', 'card empty', 'No analytics data in this period. Try a longer range or refresh platform analytics.'));
    syncControls();
    return;
  }

  const layout = node('section', 'layout');
  const mix = node('div', 'card');
  mix.append(node('h2', undefined, 'Platform mix'));
  const maxViews = Math.max(1, ...payload.platform_totals.map((item) => item.views));
  for (const item of payload.platform_totals) {
    const row = node('div', 'bar-row');
    const track = node('div', 'bar-track');
    const bar = node('div', 'bar');
    bar.style.width = `${Math.max(2, (item.views / maxViews) * 100)}%`;
    track.append(bar);
    row.append(node('span', undefined, item.platform), track, node('span', undefined, nf.format(item.views)));
    mix.append(row);
  }

  const top = node('div', 'card table-wrap');
  top.append(node('h2', undefined, 'Top posts'));
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Post', 'Views', 'Likes', 'Comments', 'Shares', 'ER']) {
    headRow.append(node('th', undefined, label));
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const post of payload.posts.slice(0, 12)) {
    const row = document.createElement('tr');
    const titleCell = node('td', 'post-title');
    titleCell.append(node('span', 'platform', post.platform), document.createTextNode(post.title ?? 'Untitled post'));
    row.append(
      titleCell,
      node('td', undefined, nf.format(post.views)),
      node('td', undefined, nf.format(post.likes)),
      node('td', undefined, nf.format(post.comments)),
      node('td', undefined, nf.format(post.shares)),
      node('td', undefined, percent(post.engagement_rate)),
    );
    body.append(row);
  }
  table.append(head, body);
  top.append(table);
  layout.append(mix, top);
  root.replaceChildren(kpis, layout);
  syncControls();
}

function syncControls() {
  const payload = state.payload;
  if (!payload) return;
  document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.days) === payload.days);
  });
  const select = document.getElementById('platform') as HTMLSelectElement | null;
  if (select) {
    const platforms = [...new Set(payload.platform_totals.map((item) => item.platform))].sort();
    const currentOptions = [...select.options].map((option) => option.value);
    for (const platform of platforms) {
      if (currentOptions.includes(platform)) continue;
      const option = document.createElement('option');
      option.value = platform;
      option.textContent = platform;
      select.append(option);
    }
    select.value = payload.platform ?? '';
  }
  setControlsDisabled(state.loading);
}

document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach((button) => {
  button.addEventListener('click', () => void reload({ days: Number(button.dataset.days) }));
});
document.getElementById('platform')?.addEventListener('change', (event) => {
  void reload({ platform: (event.target as HTMLSelectElement).value });
});
document.getElementById('refresh')?.addEventListener('click', () => void reload());
