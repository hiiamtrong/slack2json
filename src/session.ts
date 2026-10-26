import { rmSync } from 'node:fs';
import { chromium, type BrowserContext } from 'playwright-core';
import { cloneProfile, type Profile } from './chrome.ts';
import { CliError } from './errors.ts';

export interface Session { token: string; cookieHeader: string; }

// Boots the Slack web client in a throwaway copy of the Chrome profile and reads the
// workspace's xoxc token from localStorage plus the `d` session cookie.
export async function openSession(root: string, profile: Profile, workspace: string, opt: { channel: string; headed: boolean; timeoutMs: number; log: (m: string) => void }): Promise<Session> {
  const tmp = cloneProfile(root, profile.dir);
  let ctx: BrowserContext | undefined;
  try {
    opt.log(`Launching ${opt.channel}${opt.headed ? '' : ' (headless)'}`);
    try {
      ctx = await chromium.launchPersistentContext(tmp, {
        channel: opt.channel, headless: !opt.headed, timeout: Math.min(opt.timeoutMs, 60_000),
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        // Playwright's default --use-mock-keychain would leave Chrome unable to decrypt the copied cookies.
        ignoreDefaultArgs: ['--use-mock-keychain', '--enable-automation'],
        args: [`--profile-directory=${profile.dir}`],
      });
    } catch (e) {
      throw new CliError('BROWSER_FAILED', (e as Error).message.split('\n')[0], `Is "${opt.channel}" installed? Try --channel msedge|chromium`, 5);
    }
    const page = await ctx.newPage();
    await page.goto('https://app.slack.com/client', { waitUntil: 'domcontentloaded', timeout: opt.timeoutMs });
    const deadline = Date.now() + opt.timeoutMs;
    let token: string | null = null; let seen = '';
    while (!token && Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const r = await page.evaluate((ws: string) => {
        try {
          const teams = Object.values(JSON.parse(localStorage.getItem('localConfig_v2') || '{}').teams || {}) as any[];
          return { token: teams.find((t) => t.domain === ws)?.token ?? null, seen: teams.map((t) => t.domain).join(',') };
        } catch { return { token: null, seen: '' }; }
      }, workspace);
      token = r.token; seen = r.seen;
    }
    if (!token) {
      throw new CliError('NOT_LOGGED_IN', `No Slack session for "${workspace}" in profile ${profile.dir}${seen ? ` (signed in: ${seen})` : ''}`,
        `Open https://${workspace}.slack.com in Chrome profile "${profile.name}" and sign in, then retry`, 4);
    }
    const cookies = (await ctx.cookies(['https://app.slack.com'])).filter((c) => c.domain.endsWith('slack.com'));
    opt.log(`Session for ${workspace} (${profile.email ?? profile.name})`);
    return { token, cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; ') };
  } finally {
    await ctx?.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}
