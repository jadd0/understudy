# Persona data pipeline

How a scrape of a creator's public Instagram becomes the data the reply engine reads: an anonymised
bank, measured style figures, held-out splits, a drafted persona card, a retrieval corpus and a
labelled query set. Decision ids (D-0xx) refer to `.product/DECISIONS.md`.

Diagram: [persona-pipeline.html](diagrams/persona-pipeline.html), generated from the
[Diagram source](#diagram-source) at the end of this file (JSON spec:
`diagrams/persona-pipeline.dataflow.json`).

Every prompt sent to Claude or Jev in this pipeline is quoted verbatim, with its state, options and
scoring, in [PERSONA-PROMPTS.md](PERSONA-PROMPTS.md) (a gate test keeps it matching the code, ).

Status: built (PR 3a); chunks loaded into pgvector and the retrieval eval run (PR 3b, ); the newest card
file is v6 (; see [The card](#the-card) for v3 to v6); the Claude rubric judge and blind test on the test split are built (PR 9a, see
[Persona evals](#persona-evals-on-the-test-split)).

## Overview

```
raw scrape (gitignored)
   -> normalise   anonymised captions, replies, profile
   -> split       60/20/20 by post, fixed seed
   -> style       measured figures (train + style_only only)
   -> chunks      retrieval corpus (train + style_only only)
   -> draft-card  Claude writes the card from style + posts + train pairs
   -> rapid-eval  Haiku replies, Jev picks the human one, validation split
   -> queries     30 labelled fan questions for the retrieval eval
```

Everything lives under `scripts/persona/` and writes under `data/persona/`. One command runs it all
(see [Running it](#running-it)). Each stage skips when its output exists, and a stage never reads a
split it must not see. That second property is the point of the design: an evaluation on contaminated
data proves nothing.

## Sources

| | |
|---|---|
| Accounts | `@junovale` (main) and `junofilm` (secondary), both public, both the creator's own |
| Method | Read-only, through Claude in Chrome on a logged-in web session, calling Instagram's own web endpoints from the profile page. Nothing was liked, followed, commented on or saved. Captured 2026-11-03. |
| Location | `data/persona/raw/<handle>/{posts.jsonl, profile.json, NOTES.md}` |
| Git | `data/persona/raw/` is gitignored and never committed: it holds other people's comments and handles |

What was collected (from each handle's `NOTES.md`):

| | `junovale` | `junofilm` |
|---|---|---|
| Records in `posts.jsonl` | 316 (204 grid posts + 112 reels-tab-only items) | 13 (9 grid + 4 reels) |
| Her own comments | 1,056 on 139 posts (1,040 replies, 16 top-level) | none found |
| Date range | 2021-09-21 to 2026-11-01 | 2026-06-29 to 2026-08-22 |

A post record holds: shortcode, url, type (carousel, reel, photo), date, caption, hashtags, location,
pinned flag, an image description, the post owner, and `her_comments`. A comment record holds: kind
(`reply` or `top_level`), date, text (empty for a GIF or sticker, marked `non_text`), the text of the
comment she answered (`replying_to_text`), and how that was matched (`replying_to_basis`).

**Exact versus thread-first pairing.** To train on "fan comment, her reply" the scrape has to know
which comment she answered.

- `replied_to_comment_id` (569 replies) is the exact comment, taken from the API. It covers grid posts
  from index 104 onwards and every reels-only item.
- `thread_root` (471 replies) is the top-level comment of the thread her reply sits in. It covers grid
  index 0 to 103, scraped before the API fix. In a thread with several people she may have been
  answering a later reply, so the pair can be wrong.

The pipeline treats the two differently: only exact pairs are ever used as examples or for evaluation
(see [Splits](#splits-d-042)). Thread-first replies still feed style figures and retrieval.

**Collab captions.** 11 captions are not hers: collaborations owned by another account, where the
caption was written by that account. They are kept as facts about her (a brand she works with) but
flagged `voice: false`, so they never shape the voice figures. 12 more posts have an empty caption
and are likewise not voice; together that is the 23 non-voice captions (299 are voice).

Limits recorded at scrape time: like counts are hidden by the creator; image descriptions were written
from the cover frame only; one post (index 118) hit the comment scan caps, so a few of her replies
there may be missing; stories were not collected.

## Stages

Every stage is a script in `scripts/persona/` with a CLI entry and a unit test beside it.

### 1. normalise: raw to anonymised bank

| | |
|---|---|
| Script | `normalise.mjs`, `lib/anonymise.mjs` |
| In | `data/persona/raw/<handle>/` for every handle directory |
| Out | `bank/captions.jsonl`, `bank/replies.jsonl`, `bank/profile.json`, `bank/normalise.meta.json` |

What it does:

- Every `@handle` that is not one of the creator's own handles becomes `@user`. Emails become
  `[email]` and are removed from the bio. Instagram profile URLs lose their handle. Commenter
  usernames and ids are never copied: rows are built from named fields, not from raw objects.
- A reply id is the first 16 hex characters of a sha256 over shortcode, date and text, so ids are
  stable across runs.
- Collab captions get `voice: false`. GIF replies are kept with `non_text: true`. A record with no
  caption and no replies is skipped and counted.
- The contact details in the bio never enter the bank, so the persona cannot repeat them.

Counts from `bank/normalise.meta.json`:

| | |
|---|---|
| posts in / kept / skipped (no caption, no replies) | 329 / 322 / 7 |
| captions: voice / not voice (collab or empty) | 299 / 23 |
| collab captions | 11 |
| replies (all kinds) | 1056 |
| text / non-text (GIF) | 1007 / 49 |
| exact / thread-first | 569 / 471 |
| top-level comments | 16 |

Guarantee: no foreign `@handle` or email survives in any committed file (checked by
`hygiene.test.mjs`).

### 2. split: 60/20/20 by post

| | |
|---|---|
| Script | `split.mjs` |
| In | `bank/replies.jsonl` |
| Out | `bank/splits.json` |

See [Splits](#splits-d-042).

### 3. style: measured figures

| | |
|---|---|
| Script | `style.mjs` |
| In | `bank/captions.jsonl`, `bank/replies.jsonl`, `bank/splits.json` |
| Out | `bank/style.json` |

Captions and replies are reported separately. Figures are measured with `@mentions` and URLs removed,
so who she addressed does not move length or case. Replies come from the train and style_only
populations only, so the card's voice rules cannot be derived from held-out data. Percentiles are
nearest-rank; rates are shares of texts rounded to 4 places. See [Style figures](#style-figures).

### 4. chunks: the retrieval corpus

| | |
|---|---|
| Script | `chunks.mjs` |
| In | captions, replies, splits |
| Out | `bank/chunks.jsonl` |

One chunk per post (`<date> <type>: <caption> — <image description>`, source `caption`) and one per
train or style_only text reply pair (`fan: <comment> / juno: <reply>`, source `comment_reply`).
Validation and test replies never enter, and neither do GIF replies or replies with no known
comment. `--label` sets the short name in the pair text (default `juno`).

Counts: 1025 chunks = 322 caption + 287 train pairs + 416 style_only pairs.

### 5. draft-card: the persona card

| | |
|---|---|
| Script | `draft-card.mjs` |
| In | `style.json`, every post, the bio without contact details, the train pairs |
| Out | `card/v1.md`, `card/v1.meta.json` |
| Model | `--card-model` (v1 used `claude-opus-5-5`) |

The model never sees validation or test replies. It writes the card in seven fixed sections and
names 15 to 20 train pair ids; the script renders those pairs verbatim as the Examples section,
so examples cannot be paraphrased. The script rejects output with missing or reordered sections,
duplicate ids, ids outside the train pairs, or a cut-off response. It warns on a cited source
shortcode that is not in the bank. Cards v1 and v2 came from this script; v3 to v6 were revised from founder reviews (see [The card](#the-card)) and
have no `.meta.json` or `.eval.json`. To redraft from the script, change the prompt in
`draft-card.mjs` and re-run. The exact prompts are in [PERSONA-PROMPTS.md § 1](PERSONA-PROMPTS.md#1-drafting-the-card-claude).
`v1.meta.json` records the prompt's sha256, the models, the seed, every
train id given to the model, the example ids chosen, and token usage.

### 6. rapid-eval: Jev on the validation split

| | |
|---|---|
| Script | `rapid-eval.mjs` |
| In | `card/v1.md`, validation pairs |
| Out | `card/v1.eval.json` |
| Models | `--gen-model` writes replies, `--jev-model` (a pinned version, never `jev-latest`) judges |

See [Rapid eval](#rapid-eval-and-its-limit); prompts, Jev state and options in
[PERSONA-PROMPTS.md § 2–3](PERSONA-PROMPTS.md#2-writing-a-reply-as-her-claude-rapid-eval).

### 7. queries: the labelled retrieval query set

| | |
|---|---|
| Script | `queries.mjs` |
| In | `bank/chunks.jsonl` |
| Out | `eval/retrieval-queries.jsonl`, `eval/retrieval-queries.meta.json` |

Claude lists the topics the chunks cover, then writes 30 fan questions, each on a different topic,
told to avoid her wording. Each question gets 40 candidate chunks: its grounding chunks, the best 20
by lexical overlap, and a seeded random fill, shuffled so position carries no signal. Claude labels
which candidates are relevant. The grounding chunks are always candidates because a question that
avoids her wording is exactly the one lexical search misses, and a candidate set built from lexical hits
alone would hide that. A question with no relevant chunk is dropped; none were (30 asked, 30 kept).
This set is the input to the retrieval eval of . Both prompts are in
[PERSONA-PROMPTS.md § 4–5](PERSONA-PROMPTS.md#4-writing-the-retrieval-questions-claude).

## Splits

Only exactly paired text replies are split. The unit is the post, not the reply, so no post spans two
splits. Seed `understudy-2026`, ratios 0.6 / 0.2 / 0.2 (`bank/splits.json`). Everything else is
`style_only`: thread-first matches, GIFs, top-level comments, and exact replies to a GIF comment.

| split | posts | replies | used for |
|---|---|---|---|
| train | 55 | 287 | card, examples, retrieval chunks, style figures |
| validation | 18 | 132 | Jev rapid eval only |
| test | 19 | 125 | the persona evals only (`eval-persona.mjs`); never in the card, its prompt, the examples or the chunks |
| style_only | not split | 512 | style figures and retrieval chunks |

92 posts carry at least one exact pair. Reply counts do not follow 60/20/20 because posts carry very
different numbers of replies (one has 27).

**Hygiene invariants**, enforced over the committed files by `hygiene.test.mjs` (a gate step):

1. Chunks hold train and style_only replies and no validation or test reply.
2. The held-out populations are not empty (the test is not vacuous).
3. No validation or test reply appears in the card, its recorded inputs or the chunks: by id always,
   and by text for texts of 20 characters or more. Shorter texts such as "hi" also occur in train, so
   they are compared by id only.
4. No `@handle` other than the creator's own, and no email, survives in any committed file.
5. Splits, style and chunks rebuild byte-identically from the committed bank.

## Style figures

From `bank/style.json`. Rates are shares of texts.

| | captions (voice only) | replies (train + style_only text) |
|---|---|---|
| n | 299 | 750 |
| lowercase-only rate | 0.6805 | 0.7809 |
| length p50 / p90 (characters) | 16 / 47 | 9 / 24 |
| question rate | 0.0234 | 0.008 |
| exclamation rate | 0.0368 | 0.0107 |
| leading `@mention` rate | 0.0134 | 0.98 |
| Spanish-token rate | 0.0016 | 0.001 |

| | captions | replies |
|---|---|---|
| top emoji | 💋 27, 🙈 13, 😜 9 | 😏 95, 🙈 91, 😍 71, 🤭 54, ❤️ 38 |
| `:3` | 17 | 0 |
| `>.<` | 2 | 0 |
| `:)` | 5 | 1 |
| `xD` | 0 | 0 |
| `rawr` | 2 | 0 |
| top tokens (replies) | | love 71, bae 33, hey 33, baby 31, kiss 29, thank 29 |

Reply counts: 750 text replies used, 49 GIF replies, 257 text replies held out (132 validation + 125
test). Note the voice differs between the two surfaces: `:3` is a caption habit and does not appear
in replies, which is why the card says so.

## The card

The newest card file is `card/v6.md`. v2 (: no @mention opening, DM length of one or two lines with one
bubble each, song-lyric play-along, post-unlock check-in and tip thanks) was the last one drafted by the script and
the first published. Later versions were revised from founder reviews and committed without a meta or eval
file: v3 fewer emoji and a question back, v4 a hook in every reply and up to three bubbles, v5
with the conversation-reading work, v6 her full emoji palette. Which version the engine uses is database
state: the newest row with `published_at` set in `persona_cards`. The v1 figures below are kept for comparison.

`card/v1.md`, drafted by `claude-opus-5-5` (38,751 tokens in, 5,935 out; `v1.meta.json`).
Seven sections, fixed order:

| section | content | grounding |
|---|---|---|
| Identity | facts about her, one bullet each | each ends `(src: <shortcode>)` or `(src: profile)`; the script warns on a shortcode not in the bank |
| Voice rules | case, length, emoji, emoticons, slang, Spanish, punctuation, opening | each cites a `style.json` key path and its value, e.g. `replies.lowercase_only_rate = 0.7809` |
| Examples | 20 fan comment and reply pairs | rendered by the script, verbatim, from train ids the model picked |
| Not known | what to deflect rather than invent (age, relationship, address) | everything absent from Identity; the card gives deflections in her voice |
| Never | contact details, home location, real-world meetups, off-platform payment | policy; see [SAFETY.md](SAFETY.md) |
| Selling voice | how she teases a paid item | flirty, never explicit text |
| AI honesty | answer truthfully if sincerely asked, still in voice |  |

The card must contain no explicit text. The prompt says so, and the examples are chosen from
friendly or flirty pairs.

## Rapid eval and its limit

For each of the 132 validation pairs, `--gen-model` writes a reply to the fan comment with the card as
its system prompt. Jev is then asked which of two replies she wrote herself; the order is randomised
by seed. The real reply has its leading `@user` removed, so the mention cannot give it away. A pair is
"indistinguishable" if Jev picks the generated reply or is at most 0.6 confident. A failed call, or a
Jev answer outside its options, counts as an error and is never scored.

Result for card v1 (`card/v1.eval.json`; gen `claude-haiku-5-5`, Jev `jev-1.14.0`):

| | |
|---|---|
| items / errors / scored | 132 / 2 / 130 |
| indistinguishable / detected | 126 / 4 |
| **score** | **0.9692** |
| picked-generated rate | 0.7846 |
| mean Jev confidence | 0.5729 |

Card v2 (`card/v2.eval.json`, same models and seed). As first drafted: 131 scored, 1 error, 130
indistinguishable, score 0.9924, picked-generated 0.9008. After the seven founder-chosen examples were
added: 132 scored, 0 errors, 129 indistinguishable, **score 0.9773**, picked-generated rate 0.8409,
mean confidence 0.5459. Three detections instead of one out of ~132 is within noise for a judge this weak;
the same limitation applies: Jev picks the bot's reply as hers most of the time.

**Honest limitation.** Jev picked the generated reply as hers in 78.46% of scored items. A judge that
prefers the machine's reply most of the time is not discriminating, and replies this short (median 9
characters) leave little to discriminate on. The score shows the card is not obviously machine-written
to Jev; it does not show the card is good. It is a fast iteration signal, nothing more. The real
measure is the persona evals below: a separate Claude judge on the untouched test split.

## Persona evals on the test split

`npm run eval:persona -- --card-version 2 --gen-model <id> --judge-model <id>` (`eval-persona.mjs`;
, ). It reads only the 125 **test** pairs, and nothing else reads them. For each pair
`--gen-model` writes a reply with the card as its system prompt (the same `generateReply` as the
rapid eval), then `--judge-model` makes two separate calls:

1. **Rubric judge.** Sees the card's Identity and Voice rules, the fan comment and the generated
   reply, never her real reply. Scores voice, fact consistency and natural pitch from 1 to 5
   (`na` for pitch when the reply does not sell). Reported as mean and distribution per criterion.
2. **Blind test.** Sees the fan comment and two unlabelled replies, her real one and the bot's, in a
   seeded random order (`<seed>:blind`, drawn up front), and answers which is hers with a
   confidence. Reported as accuracy with a 95% Wilson interval (50% means indistinguishable), the
   accuracy per length bucket of her real reply (up to 10, 11 to 30, over 30 characters), the error
   count, and the share of "A" answers beside the share of items where the bot sat in A, so a judge
   biased to one letter shows.

Output: `docs/evals/persona.json` holds one entry per card version (models, seed, token total,
aggregate, and every item with the fan comment, her reply, the generated reply, the scores with a
one-line reason each, and the blind choice), and the persona section of [EVALS.md](EVALS.md) between its
`<!-- persona:start/end -->` markers is regenerated from it. Her replies are public and already in
the bank under the anonymisation rules. Versions and models are never pooled. Each entry
records the sha of the card text it was run against (`card_sha`), so a result is recognisable as stale
once the card changes. The file also carries a flat summary of the newest version for the analytics
dashboard: `rubric` (criterion to mean) and `blindTest` (`accuracy`, `low`, `high`, `n`).

Failure modes. Judge output that is not exactly the JSON shape in [PERSONA-PROMPTS.md](PERSONA-PROMPTS.md)
sections 6 and 7 is an error for that item, counted and never scored. A failed call is the same. The
token budget (`--budget`, default 2,000,000) aborts the run, and the cache in
`data/persona/eval/cache/` (gitignored, one file per call keyed by a hash of the model, the system
prompt and the user prompt) makes the re-run pay only for what is missing. `--limit N` runs the first
N pairs and writes nothing. The gate runs fake-client unit tests only; live calls happen only when
this command is run by hand.

```
test split ──▶ generate (card as system) ──▶ rubric judge ──▶ persona.json ──▶ EVALS.md
                         └──────────────────▶ blind judge ──┘
```

## Token cost of a build

One full build, as recorded when PR 3a ran: 822,018 tokens over 292 calls (Claude 594,762 in and
19,386 out; Jev 203,840 in). The card draft alone is 38,751 in and 5,935 out (`v1.meta.json`). The
run aborts if it passes `--budget` (default 2,000,000 tokens). Only the card draft's usage is
stored in a committed file; the full-build total is from the run log.

## Known gaps

- **Card v1 "start with the fan's @mention" is an Instagram-comment artifact.** The Voice rules say to
  open every reply with the fan's `@mention` because `replies.leading_mention_rate = 0.98`. On
  Instagram a reply to a comment always starts with the mention; in a DM there is no mention to start
  with. The Examples carry `@user` too. It is not corrected by hand (the card is never edited by hand).
  Fixed in card v2: the draft prompt forbids the opening rule and the script strips leading
  `@handles` from the rendered examples. The rapid eval strips leading mentions from both sides.
- **Names without an `@` are not anonymised.** A name a fan writes inside a comment ("thanks, <name>")
  is not a handle, so it survives in `replying_to` text and chunks.
- Image descriptions come from the cover frame only, so the facts they give are shallow.
- Thread-first pairs may be wrong, which is why they are never examples or evaluation.
- Fan comments on Instagram are public posts answered in public, which is a different register from
  a private DM.

## What comes next

- **PR 3b (done):** chunks loaded into `persona_chunks`; Voyage won recall@5 0.667 vs full-text 0.165
  (, [EVALS.md](EVALS.md)).
- **PR 4:** the engine reads the card.
- **PR 9a (done):** the rubric judge and blind test on the test split.
- **Card v2 (done):** ; published.
- **Cards v3 to v6 (done):** revised from founder reviews; not re-scored by the rapid or
  persona evals.

## Running it

```
node scripts/persona/build.mjs --creator junovale \
  --card-model claude-opus-5-5 --gen-model claude-haiku-5-5 --jev-model jev-1.14.0
```

Keys `CLAUDE_SECRET_KEY` and `TYPESAFE_SECRET_KEY` come from `.env.local`. Flags:

| flag | default | meaning |
|---|---|---|
| `--creator` | required | handle whose directory is the main account |
| `--card-model`, `--gen-model`, `--jev-model` | required (models are never defaulted) | recorded in each `*.meta.json` |
| `--query-model` | `--card-model` | model for the query set |
| `--seed` | `understudy-2026` | split, side order and candidate sampling |
| `--data` | `data/persona` | root of `raw/`, `bank/`, `card/`, `eval/` |
| `--card-version` | 1 | names `card/v<N>.md` |
| `--label` | `juno` | short name in chunk text |
| `--budget` | 2000000 | token cap |
| `--force` | none | `<step>[,<step>]` or `all`; forcing a step does not cascade, force the later steps too |

Tests: `node --test scripts/persona/*.test.mjs` (the `persona` gate step).

**For another creator.** Put the scrape in `data/persona/raw/<handle>/` (a directory per account, each
with `posts.jsonl` and `profile.json` in the same shape; every directory under `raw/` counts as one of
her own handles for anonymisation), pass a new `--data` directory so the output does not overwrite this
one, and run with `--creator <handle>`. Review the card; do not hand-edit it. Then check that the
hygiene tests pass over the new directory's files before committing, and commit only the cleaned bank.


### Adding examples and publishing a card

- **More examples, still verbatim.** `node scripts/persona/add-examples.mjs --card-version <N> --ids <id,id> --reason "<why>"`
  appends train pairs to the card's Examples section, rendered by the same function as the model-picked ones, and records
  `extra_example_ids` and the reason in `v<N>.meta.json`. Non-train ids, duplicates and pairs already present are refused.
  Re-run the rapid eval afterwards. Card v2 got seven this way.
- **Load** (`npm run persona:load -- --creator <handle>`) stores the newest `card/v<N>.md` as the next version, **unpublished**.
- **Publish** (`npm run persona:publish -- --creator <handle> --card-version <N>`) marks that body published, inserting
  it first if it isn't stored. The engine speaks only with the newest published card (`lib/engine/turn.ts`), so loading
  never changes the live voice by itself.

## Diagram source

Diagram type: data flow, left to right. Regenerate with the `archify` skill from these lists; the
JSON form is `diagrams/persona-pipeline.dataflow.json`.

Stages (columns): Source, Clean, Split, Derive, Card and eval.

Nodes:

- `raw`: Raw scrape. Two public handles, gitignored. Stage Source.
- `normalise`: Normalise. Anonymises handles, writes `bank/` captions, replies, profile. Stage Clean.
- `split`: Split. 60/20/20 by post, seed `understudy-2026`. Stage Split.
- `style`: Style. Measured figures to `style.json`. Stage Derive, top row.
- `chunks`: Chunks. Retrieval corpus, 1025 chunks. Stage Derive, bottom row.
- `card`: Draft card. Claude, from style, posts and train pairs; writes `card/v1.md`. Stage Card and eval, top row.
- `eval`: Rapid eval. Haiku replies, Jev judges, validation split, score 0.9692. Stage Card and eval, middle row.
- `persona-eval`: Persona eval. Claude rubric judge and blind test, test split, written to `docs/evals/persona.json`. Stage Card and eval, fourth row.
- `queries`: Query set. 30 labelled fan questions for the retrieval eval. Stage Card and eval, bottom row.

Edges:

- `raw` to `normalise`: posts, replies.
- `normalise` to `split`: `replies.jsonl`.
- `split` to `style`: train and style_only replies.
- `split` to `chunks`: train and style_only only, no validation or test.
- `style` to `card`: figures.
- `card` to `eval`: card v1.
- `split` to `persona-eval`: test pairs only, routed through the bottom channel.
- `chunks` to `queries`: topics (dashed).

Not drawn, for legibility: `split` supplies the train pairs to `card` and the validation pairs to
`eval`.
