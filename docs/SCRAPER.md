# Instagram scraper

**Use this only on an account you own or have written permission to collect.** The output holds other
people's comments (every fan comment the owner answered). It stays out of git: `data/persona/raw/` is
gitignored, except the two synthetic creators.

The persona pipeline starts from a raw scrape of one creator's account. This is the code that makes
that scrape, so anyone can run it on their own account and feed the result to the same pipeline
([PERSONA-PIPELINE.md](PERSONA-PIPELINE.md)). Diagram: [scraper.html](diagrams/scraper.html) (JSON spec:
`diagrams/scraper.dataflow.json`).

## Run it

1. Log in to instagram.com in a browser as the account you are collecting. In the browser's developer
   tools, copy the value of the `sessionid` cookie.
2. Put it in `.env.local` as `IG_SESSIONID=<value>` (the file is gitignored), or export it in the shell.
   The scraper alone reads this key; the app's environment does not include it.
3. Run:

```sh
node scripts/persona/scrape/scrape.mjs --handle <your_handle>
node scripts/persona/normalise.mjs --creator <your_handle>
```

`--help` prints the flags and the consent line. The scraper exits 1 and sends nothing when `IG_SESSIONID`
is missing.

| flag | default | meaning |
|---|---|---|
| `--handle` | required | the account to collect |
| `--out` | `data/persona/raw` | output root; the account lands in `<out>/<handle>/` |
| `--delay-ms` | 1500 | pause between requests; requests are sequential |
| `--max-posts` | all | stop after this many posts |
| `--max-comment-pages` | 15 | comment pages read per post |
| `--max-threads` | 30 | reply threads expanded per post |
| `--thread-pages` | 1 | pages read per reply thread |

It refuses to write into `junovale` or `junofilm`, the committed synthetic creators.

## What it writes

`<out>/<handle>/posts.jsonl`, one line per post, appended as each post finishes (a run that stops keeps
what it had), plus `profile.json` and `NOTES.md` (counts, the caps used, how many posts hit a cap). The
fields are exactly the ones `normalise.mjs` and `synth.mjs` read; `scripts/persona/fixtures/raw/alice/` is
the smallest example. Image descriptions are left empty (`description: ""`): describing images is not the
scraper's job.

Each of the owner's comments becomes a `her_comments` entry:

- A comment she wrote at the top level of a post is `kind: "top_level"`, with no target.
- A reply sits in a thread (a top-level comment and its child comments). If it opens with `@handle` and an
  earlier comment in the same thread is by that handle, it pairs to the latest such comment before the reply:
  `replying_to_basis: "replied_to_comment_id"`.
- Any other reply pairs to the thread's top-level comment: `replying_to_basis: "thread_root"`.
- A GIF or sticker has no text: `non_text: true`, `text: ""`. The same flag on the comment she answered is
  `replying_to_non_text`.

A post owned by another account (a collab she co-authors) carries `caption_author_note`, so normalise treats
its caption as a fact about her and not her voice.

## Limits

- A post that hits a cap is marked `comment_scan.more_left_unscanned: true` and counted in `NOTES.md`.
  Raise the flags to read more; the cost is more requests.
- Reels that appear only in the Reels tab are out of scope: the web app serves that tab through a POST
  endpoint and this client issues GET requests only. Reels in the profile grid are collected.
- A 401 or 403 means the session was refused (log in again and copy a fresh cookie). A 429 means rate
  limited: stop, wait, and raise `--delay-ms`. Either stops the run with a clear message.

## How it stays safe to run

- `scripts/persona/scrape/instagram.mjs` is the only code that talks to Instagram. It refuses any method
  but GET before fetch is called, sends the cookie only to `https://www.instagram.com`, does not follow
  redirects, and never logs or throws a response body or the cookie.
- The tests (`scripts/persona/scrape.test.mjs`) replay invented responses for one fictional account from
  `scripts/persona/fixtures/instagram/` and never reach Instagram: their fake fetch throws on any URL without
  a fixture. Nothing real is committed.
- The endpoint paths are collected in one table in `instagram.mjs`. They describe the web app's own JSON
  endpoints and are unverified until the first live run on your account; if Instagram changes a path or a
  response shape, that table and `record.mjs` are the places to fix.
