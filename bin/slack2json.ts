#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultChromeRoot, listProfiles, resolveProfile } from '../src/chrome.ts';
import { CliError } from '../src/errors.ts';
import { openSession } from '../src/session.ts';
import { fetchDump, makeApi, parseSince, parseTarget, renderJsonl, renderMarkdown } from '../src/slack.ts';

const VERSION = '0.1.0';
const HELP = `slack2json: dump a Slack channel or thread to JSONL (or Markdown) using a logged-in Chrome profile (headless Playwright)

USAGE
  slack2json <link|channel-id> [options]   JSONL to stdout (one message per line)
  slack2json profiles [--json]             List Chrome profiles you can pass to --profile

  <link> is a Slack permalink: a channel (https://ws.slack.com/archives/C…) dumps the channel with
  its threads; a message link (…/p1792152594288759[?thread_ts=…]) dumps just that thread.

OPTIONS
  -p, --profile <p>        Chrome profile: dir ("Profile 70"), number (70), display name or email.
                           Default: the profile Chrome used last.
  -s, --since <when>       Channel mode only. 7d, 36h, 2w or an ISO date. Default 30d.
      --no-threads         Channel mode only: skip fetching replies.
  -w, --workspace <sub>    Workspace subdomain, needed only with a bare channel id.
  -o, --out <file>         Write to this file and print its path instead of the content.
      --md                 Markdown instead of JSONL: one heading per message, replies quoted under it.
      --tz <zone>          Time zone for --md timestamps (default: this machine's). JSONL times are UTC ISO.
      --channel <c>        Browser channel: chrome (default), msedge, chromium
      --headed             Show the browser (for debugging)
      --timeout <sec>      Time limit for getting the Slack session (default 90)
      --progress           Print progress to stderr (automatic when stderr is a terminal)
  -h, --help / -v, --version

BEHAVIOR
  stdout carries only the result. Errors go to stderr as "error[CODE]: message" plus a "hint:" line.
  The Chrome profile is copied to a temp dir (cookies only) and deleted afterwards. The account must
  be a member of the channel; Slack Connect channels work when that account can open them.
  Join/leave system messages are skipped.
`;

function main(): Promise<number> { return run().catch((e: unknown) => fail(e)); }

function fail(e: unknown): number {
  const err = e instanceof CliError ? e : new CliError('UNEXPECTED', (e as Error).message ?? String(e));
  process.stderr.write(`error[${err.code}]: ${err.message}\n${err.hint ? `hint: ${err.hint}\n` : ''}`);
  return err.exit;
}

async function run(): Promise<number> {
  const { values: opt, positionals } = parseArgs({
    allowPositionals: true, strict: true,
    options: {
      profile: { type: 'string', short: 'p' }, since: { type: 'string', short: 's' }, 'no-threads': { type: 'boolean', default: false },
      workspace: { type: 'string', short: 'w' }, out: { type: 'string', short: 'o' }, json: { type: 'boolean', default: false }, md: { type: 'boolean', default: false },
      tz: { type: 'string' }, channel: { type: 'string', default: 'chrome' }, headed: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '90' }, progress: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }, version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (opt.version) { console.log(VERSION); return 0; }
  if (opt.help || positionals.length === 0) { process.stdout.write(HELP); return opt.help ? 0 : 2; }
  const verbose = opt.progress || process.stderr.isTTY === true;
  const t0 = Date.now();
  const log = (m: string) => { if (verbose) process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}\n`); };
  const root = defaultChromeRoot();

  if (positionals[0] === 'profiles') {
    const ps = listProfiles(root);
    if (opt.json) console.log(JSON.stringify(ps, null, 2));
    else for (const p of ps) console.log(`${p.dir}\t${p.name}\t${p.email ?? ''}${p.lastUsed ? '\t(last used)' : ''}`);
    return 0;
  }

  const target = parseTarget(positionals[0], opt.workspace);
  const since = parseSince(opt.since);
  const profile = resolveProfile(root, opt.profile);
  log(`Using ${profile.dir} (${profile.name}${profile.email ? ', ' + profile.email : ''})`);
  const session = await openSession(root, profile, target.workspace, { channel: opt.channel!, headed: opt.headed!, timeoutMs: Number(opt.timeout) * 1000, log });
  const api = makeApi(target.workspace, session.token, session.cookieHeader);
  const dump = await fetchDump(api, target, since, { threads: !opt['no-threads'], log });
  const body = opt.md ? renderMarkdown(dump, opt.tz) : renderJsonl(dump);
  if (opt.out) { const f = resolve(opt.out); writeFileSync(f, body); console.log(f); }
  else process.stdout.write(body);
  log('Done');
  return 0;
}

process.exitCode = await main();
