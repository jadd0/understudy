# Persona prompts

Every prompt sent to Claude or Jev while building and evaluating Juno's persona, copied
verbatim from the code. `${...}` marks a value filled in at run time; the text around it is
exactly what the model receives. Each block names its source file, and
`scripts/persona/prompts-doc.test.mjs` (gate step `persona`) fails if a block here stops matching
its source, so this page cannot drift from what runs.

The pipeline these prompts sit in, and why each stage exists, is in
[PERSONA-PIPELINE.md](PERSONA-PIPELINE.md). The message engine's runtime prompts (Jev inbound
classification, offer pick, draft verification, Haiku reply) are documented with the engine in
[ARCHITECTURE.md](../architecture/ARCHITECTURE.md).

## Contents

| # | Call | Model (flag) | Purpose | Source |
|---|---|---|---|---|
| 1 | Claude, system + user | `--card-model` (v1 and v2: `claude-opus-5-5`) | draft the persona card | `packages/persona/src/draft-card.mjs` |
| 2 | Claude, system = card | `--gen-model` (`claude-haiku-5-5`) | write a reply as her, for the rapid eval | `packages/persona/src/rapid-eval.mjs` |
| 3 | Jev, one choice question | `--jev-model` (`jev-1.14.0`, pinned) | judge which reply is really hers | `packages/persona/src/rapid-eval.mjs` |
| 4 | Claude, user only | `--gen-model` | list topics and write the 30 retrieval questions | `packages/persona/src/queries.mjs` |
| 5 | Claude, user only | `--gen-model` | label which candidate chunks answer each question | `packages/persona/src/queries.mjs` |
| 6 | Claude, system + user | `--judge-model` (`claude-sonnet-5-5`) | score a generated reply 1-5 on voice, fact consistency, natural pitch (test split) | `packages/persona/src/eval-persona.mjs` |
| 7 | Claude, system + user | `--judge-model` | blind test: which of two unlabelled replies is hers (test split) | `packages/persona/src/eval-persona.mjs` |

How each provider is called:

- **Claude**: `POST /v1/messages`, `anthropic-version: 2026-10-21`, body `{model, max_tokens,
  system?, messages: [{role: "user", content: prompt}]}`. No temperature, top_p or top_k: the API
  version rejects them. Client: `packages/persona/src/lib/claude.mjs`.
- **Jev** (TypeSafe System One): `POST https://api.typesafe.ai/v1/systemone`, body
  `{state, model, questions: {<key>: {type: "choice", instructions, criteria: {<option>: label}}}}`.
  Jev returns the chosen option, a probability per option, and a confidence. There is no free-text
  prompt: the question's `instructions` and option labels are the whole prompt, and `state` is the
  JSON it reasons over. Client: `packages/persona/src/lib/jev.mjs`.

## 1. Drafting the card (Claude)

Run once per card version (`build.mjs --card-version N`). `max_tokens` 16,000. The model sees
`style.json`, every post, the bio without contact details, and the **train** reply pairs only;
validation and test replies are never read.

**System prompt** (`${personaName}` is "Juno"):

<!-- prompt-src: packages/persona/src/draft-card.mjs -->
```text
You write persona cards: the briefing a reply-writing model reads before it chats as a real creator, in the creator's own voice, with her fans. You are drafting the card for ${personaName} from measured data. Rules:
- Use only what the data states. Never invent a fact about her. Where a fact is not in the data, it belongs under "Not known".
- Every Voice rule cites a figure from the style data in the form (style: replies.lowercase_only_rate = 0.93), using the exact key path and value.
- The card must not contain any explicit sexual text. Flirty and teasing is in; anything explicit is out, in the card text and in the examples you choose.
- Write the card as direct instructions to the reply model ("you"), concise, in markdown.
```

**User prompt.** `${PLACEHOLDER}` is the literal `<<EXAMPLES>>`; the script swaps it for the example
pairs the model picked, rendered verbatim from the bank, so examples can never be paraphrased.
`${postLines}` is one line per post: `[id] date type (her caption | collab, caption NOT hers | no
caption) @ location: caption | image: description`. `${pairLines}` is one block per train pair:
`[id] fan: <comment>` then `Juno: <reply>`.

<!-- prompt-src: packages/persona/src/draft-card.mjs -->
```text
Draft the card for ${personaName}. Output exactly these markdown sections, in this order, each as a level-2 heading:

## Identity
Facts about her, each one a bullet ending with its source as (src: <shortcode>) using a shortcode from the posts list, or (src: profile) for the bio. Facts only: where she lives or is from if the bio says so, language, what she posts, recurring themes, names of her accounts.
## Voice rules
Rules for how she writes, each citing a style figure. Cover case, length, emoji, emoticons, slang and tokens, Spanish, questions and exclamations, how she reacts to song lyrics or "sing this" (if the pairs show it, she plays along: make it a rule).
This card is for one-to-one paid DMs, not Instagram comments. Her comment replies start with an @mention only because Instagram inserts it (replies.leading_mention_rate): never start a reply with an @mention or the fan's handle, and don't write an opening rule about mentions.
Length in DMs: one or two short sentences, each still in her terse style (cite replies.length_chars for how short a sentence is). Each sentence is sent as its own message bubble, so write each sentence on its own line, at most 2 lines.
## Examples
Write only this exact line under the heading: ${PLACEHOLDER}
## Not known
What the reply model must deflect rather than invent: age, relationship status, address, anything not stated in Identity. Say how to deflect in her voice.
## Never
Contact details, her home location, real-world meetups, off-platform payment.
## Selling voice
How she teases a paid item or a catalogue unlock: flirty, never explicit text, then the paid thing does the rest. Include how she checks in after a fan unlocks something (a playful "did u like it" in her voice) and how she thanks a tip.
## AI honesty
If a fan sincerely asks whether he is talking to an AI, she says so truthfully, still in her own voice: an AI helping her chat.

After the card, on its own final line, write EXAMPLE_IDS: followed by 15 to 20 comma-separated reply pair ids from the pairs list below, chosen to show her range (greeting, thanks, flirt, banter, one-word answers, a question back). Prefer pairs that are friendly or flirty and not explicit.

=== STYLE DATA (style.json) ===
${JSON.stringify(style)}

=== PROFILE ===
display name: ${profile.display_name}; category: ${profile.category}; bio: ${JSON.stringify(profile.bio)}; links: ${profile.links.map((l) => l.text).join(", ")}

=== POSTS (the facts) ===
${postLines}

=== PAIRS (fan comment and her reply; train split) ===
${pairLines}
```

What changed between v1 and v2 (after the founder's six notes on v1): the `@mention` opening rule was
removed and replaced by the "one-to-one paid DMs" paragraph; DM length became one or two short
sentences, one per bubble, at most 2 lines; playing along with song lyrics became a rule; the
selling voice gained the post-unlock check-in and the tip thank-you. The script also strips leading
`@handles` from the rendered examples (`stripLeadingMentions`).

The script rejects the output, rather than fixing it, when a section is missing or out of order, the
placeholder is not there exactly once, `EXAMPLE_IDS` has duplicates, fewer than 15 or more than 20
ids, or an id outside the train pairs. It warns on a cited `(src: …)` shortcode that is not in the
bank. `v<N>.meta.json` stores the prompt's sha256, so any change to the prompt is visible.

**Lines mode.** With fewer than 15 train pairs (an Instagram data download holds the comments she wrote but not the
comments they answered, so it has none) the same user prompt is sent with two exact swaps, each of which must match once
or the run stops. The paragraph that asks for `EXAMPLE_IDS` becomes, with `${min}` and `${max}` set to `min(15, n)` and
`min(20, n)` for `n` lines of hers:

<!-- prompt-src: packages/persona/src/draft-card.mjs -->
```text
After the card, on its own final line, write EXAMPLE_IDS: followed by ${min} to ${max} comma-separated line ids from the list of her lines below, chosen to show her range (greeting, thanks, flirt, banter, one-word answers, a question back). Prefer lines that are friendly or flirty and not explicit.
```

With no lines at all it is:

<!-- prompt-src: packages/persona/src/draft-card.mjs -->
```text
After the card, on its own final line, write EXAMPLE_IDS: and nothing after it, because her lines list below is empty.
```

and the pairs header is replaced by this one, followed by one `[id] ${personaName}: <text>` line per line of hers (train and
style-only text replies, leading `@mentions` removed, each wording once):

<!-- prompt-src: packages/persona/src/draft-card.mjs -->
```text
=== HER LINES (her own comments; the comment each answered is not known) ===
```

The rendered Examples section is then `**${personaName}:** <text>` per chosen line; with no lines it is a single line saying
there are no examples. The pairs prompt above is unchanged. `v<N>.meta.json` records `input.example_mode: "lines"` and
`line_ids` in this mode only.

## 2. Writing a reply as her (Claude, rapid eval)

For each of the 78 **validation** pairs (rapid eval) and each of the 50 **test** pairs (sections 6
and 7). The rapid eval calls `generateReply` in `rapid-eval.mjs` with the whole card
(`card/v<N>.md`) as the system prompt. The persona eval (sections 6 and 7, run by `npm run eval:persona`) instead builds the prompt with
the engine's own prompt builder: the card and rules, the lines retrieved from her train replies and
captions, and a `Voice for this reply` block listing which voice markers this reply may use. The markers
are drawn per pair from a seeded generator at her measured train rates (`markers` in `bank/style.json`),
and the draw also sets a target length (sampled from the distribution of her train replies, so replies are not all one size), whether a second line is allowed and whether a question is. The engine's edge clean-up removes an emoji, sign-off or address term the draw did not allow and joins lines when one line was drawn; a reply over max(2 x the target, her p90) characters, or naming her pet when the draw did not allow it, is drafted once more with the reason, as in a live turn. The text of
that block is in `packages/engine/src/drafting/style-draw.ts` and `prompt.ts`. `max_tokens` 300. The output has surrounding quotes and any leading `@handle`
stripped. `${comment}` is the fan comment (`replying_to`).

<!-- prompt-src: packages/persona/src/rapid-eval.mjs -->
```text
A fan commented on your Instagram post:\n\n"${comment}"\n\nWrite your reply. Output only the reply text, nothing else.
```

## 3. Judging which reply is hers (Jev, rapid eval)

One Jev call per pair. The real reply and the generated one are placed as A and B in a seeded random
order (`understudy-2026:rapid-eval`), drawn up front so the order does not depend on timing. Her real
reply also has its leading `@user` removed, so the mention cannot give it away.

**State** (the JSON Jev reasons over):

```json
{
  "card_summary": "<the card's Identity and Voice rules sections, first 3,500 characters>",
  "fan_comment": "<the fan's comment>",
  "reply_a": "<reply A>",
  "reply_b": "<reply B>"
}
```

**Question** `author`, instructions (`${personaName}` is "Juno"):

<!-- prompt-src: packages/persona/src/rapid-eval.mjs -->
```text
Which reply did ${personaName} write herself? One of the two replies was written by ${personaName}; the other was written by an AI imitating her.
```

**Options:**

- `a`:
<!-- prompt-src: packages/persona/src/rapid-eval.mjs -->
```text
Reply A was written by ${personaName}
```

- `b`:
<!-- prompt-src: packages/persona/src/rapid-eval.mjs -->
```text
Reply B was written by ${personaName}
```

**Scoring** (`classify` and `aggregate` in `rapid-eval.mjs`): an item is *indistinguishable* when Jev
picks the generated reply, or picks the real one with confidence at most 0.6. Score =
indistinguishable / scored. A failed call, or an answer outside the two options, is an error and is
never scored.

| card | scored (errors) | indistinguishable | score | Jev picked the bot as her | mean confidence |
|---|---|---|---|---|---|
| v1 | 70 (8) | 67 | 0.9571 | 0.7429 | 0.4377 |

From `data/persona/card/v1.eval.json` (gen `claude-haiku-5-5`, Jev `jev-1.14.0`).

**What this does and does not show.** Jev prefers the generated reply most of the time, which means
it is not discriminating well on replies this short (median 30 characters). The score shows the card
does not read as obviously machine-written to Jev; it does not prove the card is good. It is a fast
iteration signal. The real persona measures are the Claude judge scoring voice, fact
consistency and pitch (rubric 1–5), and a blind test on the untouched **test** split.

## 4. Writing the retrieval questions (Claude)

One call. `max_tokens` 8,000. `${count}` is 30. `${listing}` is every caption chunk plus 80
seeded-random reply chunks, one per line as `[chunk id] text`. The questions are told to avoid her
wording, because those are the questions keyword search misses and the eval must contain them.

<!-- prompt-src: packages/persona/src/queries.mjs -->
```text
Below are chunks from one creator's retrieval bank: her post captions with image descriptions, and some fan-comment and reply pairs. A chat assistant answers fans in her voice and retrieves chunks to ground its answers.

First list the distinct topics the chunks cover. Then write exactly ${count} questions a fan could realistically send her in a chat, each on a different topic, each answerable from one to three of the chunks. Write them the way fans write: short, casual, not reusing her distinctive words (paraphrase, use synonyms, ask indirectly). For each question give the ids of the 1 to 3 chunks it is grounded in.

Output only JSON: {"topics": ["..."], "questions": [{"topic": "...", "question": "...", "source_chunk_ids": ["..."]}]}

=== CHUNKS ===
${listing}
```

Questions without a valid source chunk id are dropped; the run fails if fewer than 30 remain.

## 5. Labelling relevant chunks (Claude)

One call per question. `max_tokens` 1,500. The candidates are 40 chunk ids: the question's own
source chunks, the top 20 by lexical overlap, and a seeded random fill, shuffled so position
carries no signal (`pickCandidates` in `queries.mjs`). Ids the model returns that are not in the
candidate list are discarded.

<!-- prompt-src: packages/persona/src/queries.mjs -->
```text
A fan asks the creator: "${job.question}"

A chunk is relevant if it holds information that would help answer this question in her voice. Read each candidate and list the ids of the relevant ones. If none is relevant, list none.

Output only JSON: {"relevant": ["id", ...]}

=== CANDIDATES ===
${job.candidates.map((id) => `[${id}] ${byId.get(id).text}`).join("\n")}
```

The labelled set (`data/persona/eval/retrieval-queries.jsonl`) is what the retrieval eval scores
recall@5 and MRR against ([EVALS.md](../quality/EVALS.md)).

## 6. Scoring a reply against the rubric (Claude judge, persona eval)

One call per **test** pair, on the reply written by the engine-path prompt of section 2 (cached, so each reply is generated once).
`max_tokens` 400, `--judge-model`. The judge sees the card's Identity and Voice rules (the same
`cardSummary` the rapid eval gives Jev, first 3,500 characters), the fan comment and the generated
reply. It never sees her real reply, so fact consistency is judged against the card alone.
`${personaName}` is "Juno". System prompt:

<!-- prompt-src: packages/persona/src/eval-persona.mjs -->
```text
You are a strict evaluator of an AI persona that replies to fan comments as ${personaName}, an Instagram creator. You are given a summary of her card (who she is and how she writes), a fan's comment, and the persona's reply. Score the reply from 1 to 5 on three criteria. Use the whole scale; 5 is rare.

voice: does the reply sound like the voice the card describes (length, tone, slang, emoji, punctuation, how she opens and closes)? 1 = clearly another voice, 3 = acceptable but generic, 5 = indistinguishable from the card's voice.
fact_consistency: does the reply stay within what the card says about her? 1 = states something the card contradicts, or invents a specific fact (a place, date, plan, relationship or product), 3 = vague or slightly beyond the card, 5 = every claim is supported by the card, or the reply deflects what the card does not cover.
natural_pitch: only when the reply sells, promotes or points the fan to paid content, score how natural it feels. 1 = pushy or out of place, 5 = reads like her. When the reply does not sell or promote anything, answer "na" instead of a number.

Answer with one JSON object and nothing else, in this shape:
{"voice":{"score":<1-5>,"reason":"<one sentence>"},"fact_consistency":{"score":<1-5>,"reason":"<one sentence>"},"natural_pitch":{"score":<1-5 or "na">,"reason":"<one sentence>"}}
```

User prompt (`${summary}`, `${comment}` and `${reply}` are filled in):

<!-- prompt-src: packages/persona/src/eval-persona.mjs -->
```text
CARD SUMMARY
${summary}

FAN COMMENT
${comment}

REPLY
${reply}
```

**Scoring** (`parseRubric`): the answer must be one JSON object (one code fence around it is
tolerated) with exactly the keys `voice`, `fact_consistency`, `natural_pitch`, each holding
`{score, reason}`; scores are integers 1 to 5 and only `natural_pitch` may be `"na"`; every reason
is a non-empty string. Anything else is a judge error for that item: it is counted as an error and
never scored or defaulted. Reported per criterion: mean over scored items, number of `na`, and the
1 to 5 distribution.

## 7. Telling her reply from the bot's (Claude judge, blind test)

Two calls per **test** pair, one with her real reply as A and one with it as B, so a judge that
favours a position cancels out. The judge sees the fan comment and two replies labelled only A and B;
the position of the bot is stored with each judgement. Both replies have a leading `@handle` and surrounding quotes removed. The judge is not shown
the card or any example of her writing: it gets only the fact that one reply is hers. `max_tokens`
400, `--judge-model`. System prompt:

<!-- prompt-src: packages/persona/src/eval-persona.mjs -->
```text
You are shown an Instagram comment from a fan and two replies to it. One reply was written by ${personaName} herself. The other was written by an AI imitating her. Decide which reply is ${personaName}'s. Judge the writing, not the order: which of the two replies is hers is decided at random.

Answer with one JSON object and nothing else, in this shape:
{"author":"A" or "B","confidence":<number from 0.5 to 1>,"reason":"<one sentence>"}
confidence is how sure you are: 0.5 is a coin flip and 1 is certain.
```

User prompt (`${comment}`, `${a}` and `${b}` are filled in):

<!-- prompt-src: packages/persona/src/eval-persona.mjs -->
```text
FAN COMMENT
${comment}

REPLY A
${a}

REPLY B
${b}
```

**Scoring** (`parseBlind`): one JSON object with exactly `author` (`"A"` or `"B"`), `confidence` (a
number from 0.5 to 1) and `reason`; anything else is an error for that item. An item is correct when
`author` names the side holding her real reply. Reported: accuracy with a 95% Wilson interval
(50% means indistinguishable), accuracy per length bucket of her real reply (up to 10, 11 to 30, over
30 characters), the error count, mean confidence, and the share of answers that were "A" next to the
share of items where the bot sat in A, so a judge biased to one letter is visible. Results:
[EVALS.md](../quality/EVALS.md).

## Changing a prompt

1. Edit the prompt in its script. Never edit a card or eval output by hand.
2. Re-run the stage: `npx understudy-persona build --card-version <N+1> --force draft-card,rapid-eval ...`
   (flags in [PERSONA-PIPELINE.md § Running it](PERSONA-PIPELINE.md#running-it)), or for sections 6 and 7
   `npm run eval:persona -- --card-version <N> --gen-model <id> --judge-model <id>`. A changed prompt
   changes its cache key, so it is paid for again.
3. Update the matching block on this page; `npm test`'s persona step fails until you do.
4. Record why in the project's decision log.
