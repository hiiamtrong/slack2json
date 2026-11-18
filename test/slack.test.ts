import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attachmentName, cleanText, fetchDump, parseSince, parseTarget, permalink, renderJsonl, renderMarkdown, saveFiles, type Api, type Dump } from '../src/slack.ts';
import { CliError } from '../src/errors.ts';

test('parseTarget: channel, message, thread reply, bare id', () => {
  assert.deepEqual(parseTarget('https://acme.slack.com/archives/C0BD0UXQL1L'), { workspace: 'acme', channel: 'C0BD0UXQL1L', thread: null });
  assert.deepEqual(parseTarget('https://acme.slack.com/archives/C0BD0UXQL1L/p1792152594288759'), { workspace: 'acme', channel: 'C0BD0UXQL1L', thread: '1792152594.288759' });
  assert.deepEqual(parseTarget('https://acme.slack.com/archives/C0BD0UXQL1L/p1792600405190889?thread_ts=1792152594.288759&cid=C0BD0UXQL1L'),
    { workspace: 'acme', channel: 'C0BD0UXQL1L', thread: '1792152594.288759' });
  assert.deepEqual(parseTarget('C0BD0UXQL1L', 'acme'), { workspace: 'acme', channel: 'C0BD0UXQL1L', thread: null });
  assert.throws(() => parseTarget('C0BD0UXQL1L'), /WORKSPACE_REQUIRED|--workspace/);
  assert.throws(() => parseTarget('https://example.com/x'), /Not a Slack/);
});

test('parseSince: relative and absolute', () => {
  const now = Date.UTC(2026, 9, 26, 0, 0, 0);
  assert.equal(parseSince('7d', now), now / 1000 - 7 * 86400);
  assert.equal(parseSince('36h', now), now / 1000 - 36 * 3600);
  assert.equal(parseSince(undefined, now), now / 1000 - 30 * 86400);
  assert.equal(parseSince('2026-10-14T00:00:00Z', now), Date.UTC(2026, 9, 14) / 1000);
  assert.throws(() => parseSince('yesterday', now), /Cannot parse/);
});

test('cleanText: mentions, channels, links, entities', () => {
  const users = { U1: 'Jason Lin' };
  assert.equal(cleanText('Hi <@U1> see <#C9|general> <https://x.io|docs> <https://y.io> &lt;a&gt; <!here> <!subteam^S1|@backend>', users),
    'Hi @Jason Lin see #general [docs](https://x.io) https://y.io <a> @here @backend');
  assert.equal(cleanText(undefined, users), '');
});

const dump: Dump = {
  workspace: 'acme', channel: 'C1', channelName: 'proj', since: 1792000000, users: { U1: 'Ann', U2: 'Bob' },
  roots: [{ ts: '1792152594.288759', user: 'U1', text: 'root <@U2>', reply_count: 1, files: [{ name: 'a.csv', permalink: 'https://f' }] }],
  replies: { '1792152594.288759': [{ ts: '1792152600.000100', user: 'U2', text: 'line1\nline2', reactions: [{ name: '+1', count: 2 }] }] },
};

test('permalink: root vs reply', () => {
  assert.equal(permalink(dump, '1792152594.288759'), 'https://acme.slack.com/archives/C1/p1792152594288759');
  assert.equal(permalink(dump, '1792152600.000100', '1792152594.288759'), 'https://acme.slack.com/archives/C1/p1792152600000100?thread_ts=1792152594.288759&cid=C1');
});

test('renderMarkdown: heading per root, quoted replies, extras', () => {
  const md = renderMarkdown(dump, 'UTC');
  assert.match(md, /^# #proj \(acme, C1\) — since 2026-10-14 17:46, 1 messages, 1 replies, times in UTC/);
  assert.match(md, /\n## 2026-10-16 12:09 Ann \(1 replies\)\n<https:\/\/acme\.slack\.com\/archives\/C1\/p1792152594288759>\n\nroot @Bob\n\[file\] a\.csv https:\/\/f\n/);
  assert.match(md, /> \*\*2026-10-16 12:10 Bob\*\* <https:[^>]+thread_ts=1792152594\.288759[^>]*>\n>\n> line1\n> line2\n> \[reactions: :\+1:x2\]\n/);
});

test('renderJsonl: one line per message, replies carry thread_ts', () => {
  const rows = renderJsonl(dump).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].thread_ts, null); assert.equal(rows[0].author, 'Ann'); assert.equal(rows[0].text, 'root @Bob');
  assert.equal(rows[1].thread_ts, '1792152594.288759'); assert.equal(rows[1].files.length, 0); assert.equal(rows[1].reactions[0].count, 2);
});

test('attachmentName: keeps unicode, replaces path-unsafe characters', () => {
  assert.equal(attachmentName('1794975623.411099', { id: 'F1', name: '截圖 2026-11-18 中午12.19.13.png' }), '1794975623411099-F1-截圖 2026-11-18 中午12.19.13.png');
  assert.equal(attachmentName('1.2', { id: 'F2', name: 'a/b:c?.txt' }), '12-F2-a_b_c_.txt');
});

test('attachmentName: a long title stays under the byte limit and keeps its extension', () => {
  const short = attachmentName('1.2', { id: 'F1', name: 'b'.repeat(96) + '.png' });
  const pastLimit = attachmentName('1.2', { id: 'F2', name: 'a'.repeat(230) + '.png' });
  const cjk = attachmentName('1.2', { id: 'F3', name: '截圖'.repeat(60) + '.png' });
  const even = attachmentName('1.2', { id: 'F4', name: 'é'.repeat(100) + '.png' });
  assert.equal(short, '12-F1-' + 'b'.repeat(86) + '.png');
  assert.equal(pastLimit, '12-F2-' + 'a'.repeat(86) + '.png');
  assert.equal(even, '12-F4-' + 'é'.repeat(43) + '.png');
  assert.ok(cjk.endsWith('.png'));
  assert.ok(!cjk.includes('\uFFFD'), 'a character cut in half would show as U+FFFD');
  for (const n of [short, pastLimit, cjk, even]) assert.ok(Buffer.byteLength(n) <= 255);
  const dir = mkdtempSync(join(tmpdir(), 'slack2json-name-'));
  try {
    for (const n of [short, pastLimit, cjk, even]) { writeFileSync(join(dir, n), 'x'); assert.equal(readFileSync(join(dir, n), 'utf8'), 'x'); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('attachmentName: an extension longer than the kept part does not leak into the name', () => {
  assert.equal(attachmentName('1.2', { id: 'F', name: 'x.abcdefghijklmno' }), '12-F-x.abcdefghi');
});

test('saveFiles: downloads allowlisted hosts only and records the local path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack2json-files-'));
  const origin = globalThis.fetch; const fetched: string[] = [];
  globalThis.fetch = (async (u: URL | string) => { fetched.push(String(u)); return new Response(new Uint8Array([1, 2, 3])); }) as typeof fetch;
  try {
    const d: Dump = {
      ...dump, replies: {},
      roots: [{ ts: '1792152594.288759', user: 'U1', files: [
        { id: 'F1', name: 'a.csv', permalink: 'https://acme.slack.com/files/F1', url_private: 'https://files.slack.com/files-pri/T1-F1/a.csv?x=1' },
        { id: 'F2', name: 'evil', url_private: 'https://evil.example.com/x' },
      ] }],
    };
    const logs: string[] = [];
    const failed = await saveFiles(d, dir, 'd=1', (m) => logs.push(m));
    assert.deepEqual(fetched, ['https://files.slack.com/files-pri/T1-F1/a.csv?x=1']);
    const saved = d.roots[0].files![0].path!;
    assert.equal(saved, join(dir, '1792152594288759-F1-a.csv'));
    assert.deepEqual([...readFileSync(saved)], [1, 2, 3]);
    assert.equal(d.roots[0].files![1].path, undefined);
    assert.equal(failed, 1);
    assert.match(logs.join('\n'), /No download url for evil/);
    const row = JSON.parse(renderJsonl(d).trim());
    assert.equal(row.files[0].path, saved); assert.equal(row.files[0].url, 'https://acme.slack.com/files/F1');
    assert.match(renderMarkdown(d, 'UTC'), /\[file\] a\.csv \/.*-F1-a\.csv/);
  } finally { globalThis.fetch = origin; rmSync(dir, { recursive: true, force: true }); }
});

test('fetchDump: NO_ACCESS when the channel is unreadable, API_ERROR for anything else', async () => {
  const noAccess = (e: unknown) => e instanceof CliError && e.code === 'NO_ACCESS' && e.exit === 4;
  const target = { workspace: 'acme', channel: 'C1', thread: null };
  const infoFail: Api = async () => ({ ok: false, error: 'channel_not_found' });
  await assert.rejects(fetchDump(infoFail, target, 0, { threads: false, log: () => {} }), noAccess);

  const infoOk = { ok: true, channel: { name: 'proj' } };
  const threadFail: Api = async (m) => (m === 'conversations.info' ? infoOk : { ok: false, error: 'thread_not_found' });
  await assert.rejects(fetchDump(threadFail, { ...target, thread: '1.1' }, 0, { threads: false, log: () => {} }), noAccess);

  const otherFail: Api = async (m) => (m === 'conversations.info' ? infoOk : { ok: false, error: 'invalid_auth' });
  await assert.rejects(fetchDump(otherFail, target, 0, { threads: false, log: () => {} }),
    (e: unknown) => e instanceof CliError && e.code === 'API_ERROR' && e.exit === 5);
});

test('renderers: an empty dump is still valid output', () => {
  const empty: Dump = { workspace: 'acme', channel: 'C1', channelName: 'proj', since: 0, roots: [], replies: {}, users: {} };
  assert.equal(renderJsonl(empty), '\n');
  assert.match(renderMarkdown(empty, 'UTC'), /0 messages, 0 replies/);
  assert.equal(attachmentName('1.2', {}), '12-file-file');
});

test('saveFiles: one failed download sets no path, reports it, and the next file still lands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack2json-files-'));
  const origin = globalThis.fetch;
  const logs: string[] = [];
  globalThis.fetch = (async (u: URL | string) =>
    String(u).includes('a.csv') ? new Response('nope', { status: 500 }) : new Response(new Uint8Array([7]))) as typeof fetch;
  try {
    const d: Dump = { ...dump, roots: [{ ts: '1792152594.288759', files: [
      { id: 'F1', name: 'a.csv', url_private: 'https://files.slack.com/files-pri/T1-F1/a.csv' },
      { id: 'F2', name: 'b.png', url_private: 'https://files.slack.com/files-pri/T1-F2/b.png' },
    ] }], replies: { '1792152594.288759': [{ ts: '1792152600.000100', files: [
      { id: 'F1', name: 'a.csv', url_private: 'https://files.slack.com/files-pri/T1-F1/a.csv' },
    ] }] } };
    const failed = await saveFiles(d, dir, 'd=1', (m) => logs.push(m));
    assert.equal(failed, 1);
    assert.equal(d.roots[0].files![0].path, undefined);
    assert.equal(d.replies['1792152594.288759'][0].files![0].path, undefined);
    assert.equal(d.roots[0].files![1].path, join(dir, '1792152594288759-F2-b.png'));
    assert.deepEqual(logs.filter((m) => m.startsWith('Download failed')), ['Download failed (500) for a.csv', 'Download failed (500) for a.csv']);
  } finally { globalThis.fetch = origin; rmSync(dir, { recursive: true, force: true }); }
});

test('saveFiles: a write that fails is counted like a failed download', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack2json-files-'));
  const origin = globalThis.fetch;
  const logs: string[] = [];
  globalThis.fetch = (async () => new Response(new Uint8Array([1]))) as typeof fetch;
  try {
    const f = { id: 'F1', name: 'a.csv', url_private: 'https://files.slack.com/files-pri/T1-F1/a.csv' };
    mkdirSync(join(dir, attachmentName('1792152594.288759', f)));   // a directory in the way makes writeFileSync fail
    const d: Dump = { ...dump, replies: {}, roots: [{ ts: '1792152594.288759', files: [f] }] };
    const failed = await saveFiles(d, dir, 'd=1', (m) => logs.push(m));
    assert.equal(failed, 1);
    assert.equal(d.roots[0].files![0].path, undefined);
    assert.match(logs.join('\n'), /Write failed \(EISDIR\) for a\.csv/);
    assert.equal(existsSync(join(dir, attachmentName('1792152594.288759', f) + '.part')), false);
  } finally { globalThis.fetch = origin; rmSync(dir, { recursive: true, force: true }); }
});

test('saveFiles: the repeated file of a thread is downloaded once and shared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack2json-files-'));
  const origin = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (u: URL | string) => { fetched.push(String(u)); return new Response(new Uint8Array([7])); }) as typeof fetch;
  try {
    const file = { id: 'F9', name: 'shot.png', url_private: 'https://files.slack.com/files-pri/T1-F9/shot.png' };
    const d: Dump = { ...dump, roots: [{ ts: '1792152594.288759', files: [{ ...file }] }], replies: { '1792152594.288759': [{ ts: '1792152600.000100', files: [{ ...file }] }] } };
    await saveFiles(d, dir, 'd=1', () => {});
    assert.equal(fetched.length, 1);
    assert.equal(d.roots[0].files![0].path, join(dir, '1792152594288759-F9-shot.png'));
    assert.equal(d.replies['1792152594.288759'][0].files![0].path, d.roots[0].files![0].path);
  } finally { globalThis.fetch = origin; rmSync(dir, { recursive: true, force: true }); }
});

test('saveFiles: a rejected request propagates instead of writing a half dump', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack2json-files-'));
  const origin = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as typeof fetch;
  try {
    const d: Dump = { ...dump, replies: {}, roots: [{ ts: '1792152594.288759', files: [{ id: 'F1', name: 'a.csv', url_private: 'https://files.slack.com/files-pri/T1-F1/a.csv' }] }] };
    await assert.rejects(saveFiles(d, dir, 'd=1', () => {}), /ECONNRESET/);
    assert.equal(d.roots[0].files![0].path, undefined);
  } finally { globalThis.fetch = origin; rmSync(dir, { recursive: true, force: true }); }
});
