# slack2json

Dump a Slack channel or thread to JSONL (or Markdown) using the Slack session already in a Chrome
profile. No app, no bot token, no admin approval: if the account can open the channel in Chrome,
`slack2json` can read it, including private and Slack Connect channels.

```
slack2json https://acme.slack.com/archives/C0BD0UXQL1L -p 1 --since 14d -o channel.jsonl
slack2json "https://acme.slack.com/archives/C0BD0UXQL1L/p1792152594288759" -p 1        # one thread, to stdout
slack2json https://acme.slack.com/archives/C0BD0UXQL1L --md -o channel.md
slack2json https://acme.slack.com/archives/C0BD0UXQL1L --files ./att -o channel.jsonl   # also download attachments
slack2json profiles
```

Output: JSONL by default, one object per message in channel order, replies right after their root
and carrying `thread_ts`; each row has `ts`, `time` (UTC ISO), `author`, `text` (mentions and links
resolved), `raw_text`, `files`, `reactions` and `permalink`. `--md` writes Markdown instead: one `##`
heading per top-level message (time, author, permalink), replies as block quotes under it, files and
reactions as `[file]` / `[reactions]` lines.

Attachments: the `url` in `files` is the Slack permalink, which only opens for a signed-in browser.
With `--files <dir>` each attachment is downloaded through the session that wrote the dump and its
local path is added as `path`, which is what you want when the output feeds something else. A file
that cannot be downloaded (other workspace, removed, HTTP error) is skipped without `path` and the
run exits with `error[FILE_ERROR]`, the dump itself is still written.

How it works: copies the profile's cookies to a temp dir, boots `app.slack.com` headless, reads
the workspace's `xoxc` token from `localStorage`, then calls `conversations.history`,
`conversations.replies` and `users.info` with that token plus the `d` cookie. Playwright's
default `--use-mock-keychain` flag is disabled so Chrome can decrypt the copied cookies.

Install: `npm install && npm link`. Requires Node >= 22.18 and Google Chrome.
