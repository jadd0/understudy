# RAG: how Juno's replies are grounded

Every AI reply to a fan is written by Claude Haiku with three kinds of context: the **persona card** (who she
is and how she writes), a handful of **retrieved chunks** of her own posts and replies (what she has actually
said), and the **fan's memory profile** (what she knows about this fan). This page is the retrieval part, end to
end: what is in the corpus, how it is embedded and stored, how a fan message finds chunks, how they reach the
prompt, how the strategy was chosen, and what happens when it fails.

Related: [PERSONA-PIPELINE.md](PERSONA-PIPELINE.md) (how the corpus is built from the raw export),
[EVALS.md](EVALS.md) (the retrieval eval), [ARCHITECTURE.md](ARCHITECTURE.md) (the whole turn),
[PERSONA-PROMPTS.md](PERSONA-PROMPTS.md) (the prompts used to build and judge the persona).

## What retrieval is for, and what it is not for

- **For:** facts and tone. A fan asks "do u still have the cat?" or "what was japan like?"; the card has one
  line on each, and retrieval brings the posts and replies where she talked about it, in her words.
- **Not for safety.** Routing, hard stops, the money fence and the explicitness ceiling are decided by Jev and
  code before and after generation ([SAFETY.md](SAFETY.md)). A retrieval failure can make a reply blander; it
  can never make one unsafe.
- **Not for the persona's rules.** Voice rules, "never" rules and the selling voice live in the card, which is
  in every prompt whole. Retrieval only adds examples and facts on top.

## The flow

```
 BUILD (offline, once per creator)                       QUERY (every AI reply)
 ─────────────────────────────────                       ──────────────────────
 raw export → normalise/anonymise → split 60/20/20     fan message(s) in this turn
            │                                                    │
            ▼                                                    ▼
 chunks.mjs: bank/chunks.jsonl (785 chunks)              route() says reply / offer / deflect / ai_disclosure
            │                                                    │  (hard stops and holds never retrieve)
            ▼                                                    ▼
 load.ts: Voyage voyage-4, input_type=document,          PersonaRetriever (strategy = config retrieval.strategy)
          1024 dims → persona_chunks (one transaction)     vector: Voyage input_type=query → pgvector cosine, top k
            │                                              fts:    to_tsquery OR-terms → ts_rank_cd, top k
            ▼                                              hybrid: both top 20 → reciprocal rank fusion, top k
 persona_chunks: embedding vector(1024) [HNSW cosine]            │  Voyage error → falls back to fts
                 tsv tsvector (generated) [GIN]                  ▼
                 creator_id, meta.chunk_id, source        promptText(): strip the Instagram "@user" from replies
                                                                 │
                                                                 ▼
                                                          prompt.ts: per-turn system suffix
                                                          "## Things she has said or posted (for facts and tone)"
                                                                 │
                                                                 ▼
                                                          Haiku drafts → Jev + code verify → commit
```

## 1. The corpus

Built by `packages/persona/src/chunks.mjs` from the anonymised bank into `data/persona/bank/chunks.jsonl`.

| chunk kind | count | text format | example |
|---|---|---|---|
| post (`source: caption`) | 234 | `<date> <type>: <caption> — <image description>` | `2022-01-25 reel: attempt number 40ish. the railings are my best friend — A woman in a chunky knit jumper wobbles on mint-wheeled roller skates while gripping the seafront railings.` |
| reply pair, train split | 172 | `fan: <comment> / juno: <her reply>` | `fan: where's the shop?? need that blazer / juno: @user north laine, come say hi` |
| reply pair, style-only | 379 | same | (replies used for style, never for evaluation) |
| **total** | **785** | | |

Counts are from `data/persona/bank/chunks.jsonl`.

What never enters:

- **Validation and test replies**. Those are held out for the rapid eval and the blind test. `load.ts`
  refuses to write anything if one appears, and `hygiene.test.mjs` checks the committed chunks for held-out ids
  and texts.
- **Other people's handles and emails**. Every `@handle` except hers is replaced with `@user` at
  normalisation. A real scrape under `data/persona/raw/` is gitignored; Juno's synthetic records are committed.
- **Non-text replies** (emoji-only image stickers, empty replies).

One post = one chunk, and one reply pair = one chunk. Chunks are short (a caption plus a one-line image
description, or a comment and her reply), so nothing is split mid-thought and no overlap windows are needed.

## 2. Embedding and storage

`npm run persona:load -- --creator junovale` (`scripts/persona/load.ts`):

1. Reads `chunks.jsonl`, refuses held-out ids and duplicate chunk ids, and writes nothing on either.
2. Embeds every chunk with **Voyage `voyage-4`** (`retrieval.voyage_model` config row), `input_type: "document"`,
   `output_dimension: 1024`, through `providers/voyage/embed.ts`.
   - Batches are 100 texts, 21 s apart, with 5 retries 30 s apart on 429/5xx. These are the limits of a Voyage
     account with no payment method (3 requests and 10K tokens a minute).
   - The full load takes several minutes at those limits.
3. In **one transaction**, deletes the creator's chunks and inserts all 785, so a re-run leaves the same rows
   and a failure leaves the old ones. All embedding happens before the transaction opens.
4. Stores the newest card file as the next card version, **unpublished**. Publishing is a separate step
   (`npm run persona:publish`); the engine reads only the newest published card.

Table `persona_chunks` (`db/schema.ts`):

| column | type | purpose |
|---|---|---|
| `creator_id` | uuid | every query is scoped to one creator (btree index) |
| `source` | text | `caption` or `comment_reply` |
| `text` | text | what is embedded, searched and shown to the model |
| `meta` | jsonb | `chunk_id` (the bank's stable id, `cap_…` / `rep_…`), date, post shortcode, split |
| `embedding` | vector(1024) | Voyage document embedding; **HNSW index, cosine ops** |
| `tsv` | tsvector, generated | `to_tsvector('simple', text)`; **GIN index** |

The `simple` text-search configuration is used because her text is lowercase slang, emoji and mixed
English/Spanish: an English stemmer would mangle "ur", "pookie" and "meow".

## 3. At query time

Called from `lib/engine/turn.ts` only for routes that write a reply (`reply`, `offer`, `deflect`,
`ai_disclosure`); a hard stop, a hold for Juno or a template never retrieves.

- **Query text:** the fan messages in this turn's batch, joined with newlines (a burst of three messages is one
  query).
- **k:** `retrieval.k` config row, **5**.
- **Strategy:** `retrieval.strategy` config row, read when the engine's dependencies are built
  (`lib/engine/deps.ts`). It is **`vector`** on the dev database since the retrieval eval. The seed default is
  `fts`, so a fresh database works with no Voyage key until the eval has been run.

The three strategies (`lib/persona/retrieve.ts`):

| strategy | how | cost per reply |
|---|---|---|
| `vector` | Voyage embeds the query (`input_type: "query"`), then `order by embedding <=> $q` (cosine distance) over the creator's chunks, top k | one Voyage call (a few tokens) + one indexed query |
| `fts` | the query's alphanumeric terms, minus a short stopword list, OR-ed into `to_tsquery('simple', …)`; ranked by `ts_rank_cd`, top k | one indexed query |
| `hybrid` | the top 20 of both, fused by reciprocal rank fusion (k = 60, score = Σ 1/(60 + rank)), top k | both of the above |

The adapter is `providers/voyage/persona-retriever.ts` (`PersonaRetriever`), behind the engine's retriever port
(`platform/ports/retriever.ts`), so tests swap in a fake and no engine code knows which strategy runs.

**Failure behaviour.**

| what fails | what happens |
|---|---|
| Voyage call (vector/hybrid) errors or times out | logged, and the same turn falls back to `fts`: a weaker list beats none |
| the whole retrieval throws (database error) | logged; the turn continues with **no** chunks (`turn.ts`), and the card alone carries the reply |
| no chunk matches (fts with no shared word) | empty list; the prompt simply has no "Things she has said" section |
| `retrieval.strategy` holds anything but the three names | the engine refuses to build its dependencies, rather than guess |

## 4. Into the prompt

`lib/engine/prompt.ts` splits Haiku's system prompt in two:

- **Cached prefix** (identical on every turn for a creator, sent with `cache_control`, read from cache after the
  first call): the published persona card, the answering rules and the creator's "never talk about"
  list.
- **Per-turn suffix:** the instruction for this route, the item to tease (offers only), **the retrieved chunks**,
  and the fan's memory profile.

Chunks never go in the cached prefix, because they change every turn and would break the cache.

Before a chunk reaches the prompt, `promptText()` removes the Instagram `@mention` from reply chunks
(`juno: @user you` → `juno: you`). Instagram adds that mention to every comment reply; a DM never has one, and a
page of "@user …" examples taught the model to open DMs with "@user". The stored and embedded text is
unchanged, so nothing has to be re-embedded.

The section heading, verbatim:

<!-- prompt-src: lib/engine/prompt.ts -->
```text
## Things she has said or posted (for facts and tone)
```

Each chunk follows as one `- <text>` line. The whole Haiku prompt, including this section, is in
[ARCHITECTURE.md § Engine prompts](ARCHITECTURE.md).

Every turn row records the persona card version used, the models, tokens, cost and timings, so the turn explorer
in `/analytics` shows which card a reply came from. The chunk ids are not stored on the turn; that is a known gap
below.

## 5. Why vector: the eval

The plan was that Voyage would be used only if a measured eval showed it was genuinely better than Postgres full-text
search. `npm run eval:retrieval` ran all three strategies on 30 labelled fan questions written to avoid her
wording (`data/persona/eval/retrieval-queries.jsonl`). The query set was committed before any result existed.

| strategy | recall@5 | MRR | hit@5 | mean ms (db only) |
|---|---|---|---|---|
| fts | 0.331 | 0.480 | 0.73 | 19.1 |
| **vector** | **0.560** | **0.933** | **0.97** | 32.2 |
| hybrid | 0.482 | 0.862 | 0.93 | 37.7 |

Source: `data/persona/eval/retrieval-results.json` (corpus 785 chunks, k = 5, `voyage-4`).

Vector finds a relevant chunk in the top 5 for 97% of questions; full-text finds one for 73%. Fans ask "did you
ever manage the turning on the spot thing on skates??" and she posted "learned to spin": no shared word, the same
meaning. Hybrid loses to vector because full-text's weaker list dilutes the fusion. The labelling pool understates
recall, most of all for vector, so the margin is if anything conservative.
Full method: [EVALS.md](EVALS.md).

## 6. Changing it

| change | how |
|---|---|
| switch strategy | update the `retrieval.strategy` config row; no deploy needed |
| change k | `retrieval.k` config row |
| new posts or replies | re-run the persona build, then `persona:load`, then `eval:retrieval` to check the strategy still wins |
| another creator | the same pipeline with their handle; every query is already scoped by `creator_id` |
| a different embedding model | `retrieval.voyage_model`, then a full re-load (old and new vectors cannot be mixed) |

## 7. Known gaps

- **The turn does not record which chunks it used.** The explorer can't show "this reply leaned on these posts".
  Adding chunk ids to `turns.jev_in` (or a column) would close it.
- **The query is the raw fan text.** A one-word message ("meow") retrieves on one word. A short query rewrite
  with Jev's intent would help.
- **No chunk-level relevance cut-off.** The top 5 are always passed, even when the best is a weak match.
- **The label pool understates recall**, and the eval has 30 questions; it settles vector vs full-text
  clearly but not small differences.
- **Load has no resume**: a Voyage failure mid-run discards the run, and `eval:retrieval` has no guard
  against pointing at the wrong database.
