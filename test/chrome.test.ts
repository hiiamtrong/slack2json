import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { cloneProfile } from '../src/chrome.ts';

test('cloneProfile: keeps only Local State and the cookies of the given hosts, no Preferences', () => {
  const root = mkdtempSync(join(tmpdir(), 'slack2json-chrome-'));
  writeFileSync(join(root, 'Local State'), '{}');
  mkdirSync(join(root, 'Default'), { recursive: true });
  const db = new DatabaseSync(join(root, 'Default/Cookies'));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT)');
  for (const h of ['.slack.com', 'app.slack.com', '.google.com', 'accounts.google.com', 'evilslack.com']) {
    db.prepare('INSERT INTO cookies VALUES (?, ?)').run(h, 'c');
  }
  db.close();
  writeFileSync(join(root, 'Default/Preferences'), '{}');
  const tmp = cloneProfile(root, 'Default', ['slack.com']);
  try {
    assert.equal(existsSync(join(tmp, 'Default/Preferences')), false);
    const kept = new DatabaseSync(join(tmp, 'Default/Cookies'));
    assert.deepEqual(
      (kept.prepare('SELECT host_key FROM cookies ORDER BY host_key').all() as { host_key: string }[]).map((r) => r.host_key),
      ['.slack.com', 'app.slack.com'],
    );
    kept.close();
  } finally {
    rmSync(root, { recursive: true });
    rmSync(tmp, { recursive: true });
  }
});
