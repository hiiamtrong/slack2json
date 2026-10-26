import { CliError } from './errors.ts';

export interface Target {
  workspace: string;        // subdomain, e.g. "sotatek-premium"
  channel: string;          // C…/G…/D…
  thread: string | null;    // root ts of a thread, when the input points at one message
}

// Accepts: https://<ws>.slack.com/archives/<C>[/p<16 digits>][?thread_ts=…&cid=…]
export function parseTarget(input: string, workspace?: string): Target {
  if (/^[CGD][A-Z0-9]{8,}$/.test(input)) {
    if (!workspace) throw new CliError('WORKSPACE_REQUIRED', 'A bare channel id needs --workspace <subdomain>', 'Or pass the full https://<ws>.slack.com/archives/… link', 2);
    return { workspace, channel: input, thread: null };
  }
  let u: URL;
  try { u = new URL(input); } catch { throw new CliError('BAD_INPUT', `Not a Slack link or channel id: ${input}`, 'Expected https://<ws>.slack.com/archives/C…/p… or a channel id', 2); }
  const ws = u.hostname.match(/^([^.]+)\.slack\.com$/)?.[1];
  const m = u.pathname.match(/^\/archives\/([CGD][A-Z0-9]+)(?:\/p(\d{16}))?/);
  if (!ws || !m) throw new CliError('BAD_INPUT', `Not a Slack archives link: ${input}`, 'Expected https://<ws>.slack.com/archives/C…/p…', 2);
  const msgTs = m[2] ? `${m[2].slice(0, 10)}.${m[2].slice(10)}` : null;
  const thread = u.searchParams.get('thread_ts') ?? msgTs;
  return { workspace: workspace ?? ws, channel: m[1], thread };
}

export function parseSince(v: string | undefined, now = Date.now()): number {
  if (!v) return now / 1000 - 30 * 86400;
  const rel = v.match(/^(\d+)([dhw])$/);
  if (rel) return now / 1000 - Number(rel[1]) * { d: 86400, h: 3600, w: 7 * 86400 }[rel[2] as 'd' | 'h' | 'w']!;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new CliError('BAD_SINCE', `Cannot parse --since "${v}"`, 'Use 7d, 36h, 2w or an ISO date like 2026-10-14', 2);
  return t / 1000;
}

export interface Message {
  ts: string; thread_ts?: string; user?: string; username?: string; bot_profile?: { name?: string };
  text?: string; subtype?: string; reply_count?: number; edited?: unknown;
  files?: { name?: string; title?: string; permalink?: string }[];
  reactions?: { name: string; count: number }[];
}

export type Api = (method: string, params: Record<string, string>) => Promise<any>;

// Slack web API with the browser's xoxc token: cookie `d` must travel with it.
export function makeApi(workspace: string, token: string, cookieHeader: string): Api {
  return async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`https://${workspace}.slack.com/api/${method}`, {
        method: 'POST', headers: { Cookie: cookieHeader }, body: new URLSearchParams({ ...params, token }),
      });
      const j = await r.json() as any;
      if (j.ok || j.error !== 'ratelimited' || attempt >= 5) return j;
      await new Promise((res) => setTimeout(res, 1000 * (Number(r.headers.get('retry-after')) || 2 ** attempt)));
    }
  };
}

async function paged(api: Api, method: string, params: Record<string, string>, what: string): Promise<Message[]> {
  const out: Message[] = []; let cursor = '';
  do {
    const r = await api(method, { ...params, limit: '200', ...(cursor ? { cursor } : {}) });
    if (!r.ok) {
      if (r.error === 'channel_not_found' || r.error === 'not_in_channel' || r.error === 'thread_not_found')
        throw new CliError('NO_ACCESS', `Slack returned ${r.error} for ${what}`, 'Check the link and that this Chrome profile\'s account is a member of the channel', 4);
      throw new CliError('API_ERROR', `${method}: ${r.error}`, undefined, 5);
    }
    out.push(...r.messages); cursor = r.response_metadata?.next_cursor ?? '';
  } while (cursor);
  return out;
}

export interface Dump {
  workspace: string; channel: string; channelName: string; since: number | null;
  roots: Message[]; replies: Record<string, Message[]>; users: Record<string, string>;
}

const SKIP = new Set(['channel_join', 'channel_leave', 'bot_add', 'channel_purpose', 'channel_topic']);

export async function fetchDump(api: Api, t: Target, since: number, opts: { threads: boolean; log: (m: string) => void }): Promise<Dump> {
  const info = await api('conversations.info', { channel: t.channel });
  if (!info.ok) throw new CliError('NO_ACCESS', `Slack returned ${info.error} for ${t.channel}`, 'Check the link and that this Chrome profile\'s account is a member of the channel', 4);
  const channelName = info.channel?.name ?? t.channel;
  let roots: Message[]; const replies: Record<string, Message[]> = {};
  if (t.thread) {
    const all = await paged(api, 'conversations.replies', { channel: t.channel, ts: t.thread }, `thread ${t.thread}`);
    roots = all.slice(0, 1); replies[t.thread] = all.slice(1);
  } else {
    roots = (await paged(api, 'conversations.history', { channel: t.channel, oldest: String(since) }, `channel ${t.channel}`))
      .filter((m) => !SKIP.has(m.subtype ?? ''));
    opts.log(`${roots.length} messages in #${channelName}`);
    if (opts.threads) for (const m of roots) if (m.reply_count) {
      replies[m.ts] = (await paged(api, 'conversations.replies', { channel: t.channel, ts: m.ts }, `thread ${m.ts}`)).slice(1);
    }
  }
  roots.sort((a, b) => Number(a.ts) - Number(b.ts));
  const ids = new Set<string>();
  const collect = (m: Message) => { if (m.user) ids.add(m.user); for (const id of (m.text ?? '').matchAll(/<@(U[A-Z0-9]+)/g)) ids.add(id[1]); };
  roots.forEach(collect); Object.values(replies).flat().forEach(collect);
  const users: Record<string, string> = {};
  for (const id of ids) {
    const r = await api('users.info', { user: id });
    users[id] = r.ok ? (r.user.real_name || r.user.name) : id;
  }
  opts.log(`${Object.keys(replies).length} threads, ${ids.size} users`);
  return { workspace: t.workspace, channel: t.channel, channelName, since: t.thread ? null : since, roots, replies, users };
}

// ── rendering ───────────────────────────────────────────────────────────────

export function cleanText(text: string | undefined, users: Record<string, string>): string {
  return (text ?? '')
    .replace(/<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => '@' + (users[id] ?? id))
    .replace(/<#([CGD][A-Z0-9]+)\|([^>]*)>/g, '#$2')
    .replace(/<!subteam\^[^|>]+\|@?([^>]+)>/g, '@$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '[$2]($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

export function author(m: Message, users: Record<string, string>): string {
  return (m.user && users[m.user]) || m.username || m.bot_profile?.name || m.user || '?';
}

export function permalink(d: Pick<Dump, 'workspace' | 'channel'>, ts: string, threadTs?: string): string {
  const base = `https://${d.workspace}.slack.com/archives/${d.channel}/p${ts.replace('.', '')}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${d.channel}` : base;
}

export function fmtTime(ts: string | number, tz?: string): string {
  const dt = new Date(Number(ts) * 1000);
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(dt);
  return p.replace(',', '');
}

function extras(m: Message, indent: string): string[] {
  const out: string[] = [];
  for (const f of m.files ?? []) out.push(`${indent}[file] ${f.title || f.name || 'file'}${f.permalink ? ' ' + f.permalink : ''}`);
  if (m.reactions?.length) out.push(`${indent}[reactions: ${m.reactions.map((r) => `:${r.name}:x${r.count}`).join(' ')}]`);
  return out;
}

export function renderMarkdown(d: Dump, tz?: string): string {
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nReplies = Object.values(d.replies).reduce((n, r) => n + r.length, 0);
  const scope = d.since === null ? `thread` : `since ${fmtTime(d.since, zone)}`;
  const lines = [`# #${d.channelName} (${d.workspace}, ${d.channel}) — ${scope}, ${d.roots.length} messages, ${nReplies} replies, times in ${zone}`, ''];
  for (const m of d.roots) {
    lines.push(`## ${fmtTime(m.ts, zone)} ${author(m, d.users)}${m.reply_count ? ` (${m.reply_count} replies)` : ''}`, `<${permalink(d, m.ts)}>`, '', cleanText(m.text, d.users), ...extras(m, ''), '');
    for (const r of d.replies[m.ts] ?? []) {
      lines.push(`> **${fmtTime(r.ts, zone)} ${author(r, d.users)}** <${permalink(d, r.ts, m.ts)}>`, '>');
      lines.push(...cleanText(r.text, d.users).split('\n').map((l) => '> ' + l), ...extras(r, '> '), '');
    }
  }
  return lines.join('\n');
}

export function renderJsonl(d: Dump): string {
  const row = (m: Message, thread_ts: string | null) => JSON.stringify({
    ts: m.ts, time: new Date(Number(m.ts) * 1000).toISOString(), thread_ts, channel: d.channel, channel_name: d.channelName,
    user: m.user ?? null, author: author(m, d.users), text: cleanText(m.text, d.users), raw_text: m.text ?? '',
    files: (m.files ?? []).map((f) => ({ name: f.title || f.name, url: f.permalink })), reactions: m.reactions ?? [],
    permalink: permalink(d, m.ts, thread_ts ?? undefined),
  });
  const out: string[] = [];
  for (const m of d.roots) { out.push(row(m, null)); for (const r of d.replies[m.ts] ?? []) out.push(row(r, m.ts)); }
  return out.join('\n') + '\n';
}
