import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanText, parseSince, parseTarget, permalink, renderJsonl, renderMarkdown, type Dump } from '../src/slack.ts';

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
