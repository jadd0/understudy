# Case study: from a take-home to a library

This is how a take-home exercise became an engine other people can run. It is written from what the repository
records, and every number in it is linked to the file that holds it. Where something is not measured, it says so.

## The brief

The exercise was to build the core of a chat product for a creator platform: an AI that chats with fans as the
creator, behaves safely, sells naturally, hands the conversation to a human when it should, and comes with
quantitative evidence that it works ([APP.md](app/APP.md#1-the-product-and-its-actors) states the brief in those
terms). The creator in the exercise was a real person. Nothing about her is in this repository: the demo creator, Juno
Vale, is generated, and the rest of this document says how that was kept true.

Five verbs, then, and each one became a rule before it became code. *Chat as her* meant a persona built from her own
posts and replies, not a paragraph of adjectives. *Stay safe* meant the model never decides a stop; code does.
*Sell naturally* meant the model never chooses a price or an item. *Hand off* meant a human taking over always wins a
race with the AI. *Measure* meant an evaluation that can fail. The one-line version, which the README keeps at the top,
is that code decides and models only write.

## What the review named

The first version was one Next.js app for one creator. A review of it named three gaps, and they shaped everything
after:

- **Escalation.** A chat held for the creator needed a clock for when she never came, and a different rule for the
  cases that must never be settled by a timer.
- **A multi-creator data model.** Every table that belonged to a creator needed to say whose it was, before there was a
  second creator to get it wrong.
- **Continuity.** The reply path depended on outside services, and it needed a stated answer for each one going down.

None of the three was a new feature. Each was something the first version had decided by omission, and each turned
out to be a property that tests could state.

## Going public

The repository had to be publishable without the creator in it. That is a harder constraint than it sounds, because
the product is built from her words.

The demo creator is synthetic end to end. Code chose the structure (which posts, which replies, which fans), and a
model wrote the sentences, so no caption or comment in `data/` was ever hers
([PERSONA-PIPELINE.md](persona/PERSONA-PIPELINE.md#sources) describes the generator). The real scrape stays outside the
repository, in a directory only the maintainer has.

Three checks hold the line, and the gate runs all of them:

- A **leak checker** reads that private directory and fails if any six-word run of a caption or a reply, or any
  handle of five characters or more that appears in it, shows up in a tracked file. Copying a sentence without a name
  on it is still copying.
- A **names check** reads a second private file, a list of names that must never appear, and fails on any tracked file
  or path that contains one. It exists because a handle floor of five characters cannot catch a short name, and
  because a name is not always a handle. It reports a file and a line and the length of the match, never the term, so
  its own output is safe to paste.
- A **public-files check** fails on any tracked file that cites a planning document, a decision number or a pull
  request number a stranger could not follow, and a **link check** fails on any relative link that does not resolve.

A check that cannot run because its input is missing used to pass. It now fails when asked to require its inputs, and
`npm run check` asks. Nothing is proven by a scan of an empty directory.

## From app to library

The first version put the conversation engine inside the app. The second question after "does it work" was "can
anything else use it", and the answer was no: the engine read the app's wallet, its catalogue and its user table
directly.

The move to a library had four parts:

1. **Packages.** The engine, the provider adapters (Claude, Jev, failover, Postgres and Voyage retrieval) and the
   persona pipeline became three workspace packages under `packages/`. The engine knows its ports and nothing else.
2. **A host port.** Everything the engine needs from tables it does not own (a fan's wallet facts, the catalogue and
   who owns what, the accounts it may flag) goes through one interface,
   [`HostPort`](../packages/engine/src/ports/host.ts). The app implements it over its database; the headless server
   implements it over a catalogue file, with no wallet.
3. **The engine owns its migrations.** Its tables carry no foreign key to a host table, so it can create them on a
   database that has no users table at all. A host calls `migrate()` and the engine applies its own set, under an
   advisory lock, safe to repeat ([engine README](../packages/engine/README.md#tables-and-migrations)).
4. **Two hosts.** A library with one consumer is a module. The Fastify server in
   [examples/server](../examples/server/README.md) is the second consumer, with no wallet and no UI, and it is why the
   host port is as small as it is: anything the second host could not supply had to come out of the engine.

The boundary is tested, not asserted. A test in each package fails the build when code in it reaches past a published
entry or imports from a host ([engine](../packages/engine/src/ports/boundary.test.ts),
[providers](../packages/providers/src/boundary.test.ts)). Two consumers and a failing build are what kept the seam
honest through the later changes.

## Closing the review's gaps

Each gap from the review became a mechanism with a test, and a document that says what is and is not covered.

**Escalation.** A chat held for the creator gets a short holding line and a due time. The sweep settles an overdue
hold by policy and gives the chat back to the AI. A Trust and Safety hold is never settled by a clock: past its limit
it is stamped late and announced on an ops channel, and it stays open
([SAFETY.md](safety/SAFETY.md), [escalation.ts](../packages/engine/src/conversation/escalation.ts)).

**Many creators.** Every top-level creator-owned row carries `creator_id`, and rows that hang off a conversation reach
the creator through a foreign key. An isolation test asserts that no chunk, card, config row, catalogue item or memory
crosses between two creators ([isolation.db.test.ts](../packages/engine/src/db/isolation.db.test.ts)). Scale was
measured rather than argued: at 200 creators, 20,000 conversations and a million messages, the per-turn queries are
all under a millisecond, and the one that was not (the sweep) got one index
([SCALING.md](operations/SCALING.md)). Partitioning is designed in that document and deliberately not built, because
the measured volume does not need it.

**Continuity.** Each outside service sits behind one adapter and a port, so a fallback is another implementation of
the same port. A second model backs the drafting model, Claude backs the classifier, full-text search backs embeddings
and polling backs realtime; the model fallbacks sit behind circuit breakers. The document lists what each failure looks
like and what is not covered ([CONTINUITY.md](operations/CONTINUITY.md)): Stripe top-ups, the database and the sign-in
bot check have no fallback, and it says so.

## Making it usable

A library that needs a stranger to stand up six services is not usable. Five changes were about that:

- **Minimal mode.** Postgres and one model key. Jev, Voyage, Stripe, Pusher, Resend and Turnstile each degrade to a
  stated fallback when absent (the table in the [README](../README.md#ten-minute-start)), and production refuses to
  skip the two that guard sign-in.
- **`init`.** One command takes a creator from her own Instagram data download, or a scrape of her own session, to a
  published persona, in two phases with a pause for her to read and edit the card. It reads her account only, refuses a
  handle that is not the session's own, and never opens a direct message
  ([PERSONA-PIPELINE.md](persona/PERSONA-PIPELINE.md#onboarding-a-creator-npx-understudy-init)).
- **Any creator.** The app had a demo creator written into its code. It now reads creators from the database, reaches
  one by handle, and has a catalogue editor, so a second creator made by `init` is scoped, priced and pitched end to
  end without a code change.
- **A gateway.** An adapter for a self-hosted, OpenAI-compatible gateway with a per-creator gateway key, switched on by
  platform config rows and sitting in front of the existing providers
  ([CONFIG.md](operations/CONFIG.md), [gateway adapter](../packages/providers/src/gateway)).
- **Packages.** The three packages build to plain JavaScript with type declarations, so a host outside this repository
  can depend on them.

The test for all of it is the README's: a stranger with Node, npm and Docker, and no keys, sees a scripted fan talk to
Juno within ten minutes. That sentence is checked by a script that reads every command in the README and fails if one
names a script, a binary or a file that is not in the tree.

## Voice realism

The first persona check was a fast one: Jev is shown two replies and asked which she wrote. Card v1 scored 0.9571 on it,
and Jev picked the generated reply as hers in 74.29% of scored items. That is not a result. A judge that prefers the
machine's reply most of the time is not discriminating, and the pipeline's own document says so
([PERSONA-PIPELINE.md](persona/PERSONA-PIPELINE.md#rapid-eval-and-its-limit)). It is kept as a quick signal for
iteration and nothing else.

The measure that replaced it is a separate Claude judge on the test split, which no script reads before it. On card v2
(v1 plus hand-written rules for a DM: one to three short lines, callbacks to earlier chat, a hook at the end, a question
only when it fits), the judge picked her real reply 58 times in 100, which is 58.0% accuracy with a 95% interval of
48.2% to 67.2%. The interval includes 50%, so on this sample the judge cannot reliably tell her reply from the bot's.
It also answered "A" 72.0% of the time, and its accuracy was 36.0% with the bot in A and 80.0% with the bot in B. A
position bias that large pulls the figure toward 50% regardless of the writing, so 58.0% is not evidence that the voice
is perfect. It is evidence that the number is no longer obviously worse than chance, measured by a method that can
fail ([EVALS.md](quality/EVALS.md)).

Retrieval got the same treatment. Voyage embeddings were adopted only because the eval said they were better: recall at
5 of 0.560 for vector search against 0.331 for full text, with hybrid between at 0.482. Full-text search stayed as the
fallback and as the engine of the one-key start.

One result is easy to misread. The engine eval passes with zero safety violations and zero errored turns across 64
threads and 99 turns, and 14 turns still missed the expectation their own thread set. Those are reported, not gated: the bar
is that nothing unsafe is sent, not that every routing choice matches a script.

## What the numbers say

| claim | result | source |
|---|---|---|
| Nothing unsafe sent in the scripted eval | 0 safety violations, 0 errored turns, 64 threads and 99 turns | [EVALS.md](quality/EVALS.md) |
| Cost of a reply | $0.0002 per replying turn | [EVALS.md](quality/EVALS.md) |
| Retrieval, recall at 5 | vector 0.560, full text 0.331, hybrid 0.482 | [EVALS.md](quality/EVALS.md) |
| Can a judge tell her from the bot | 58.0%, 95% interval 48.2 to 67.2%, position bias present | [EVALS.md](quality/EVALS.md) |
| Hot paths at a million messages | lease claim 0.09 ms, facts 0.17 ms, vector retrieval 0.29 ms (p50) | [SCALING.md](operations/SCALING.md) |
| The one index | sweep 21.8 ms to 5.07 ms (p50) | [SCALING.md](operations/SCALING.md) |

## What is still open

- **The blind test is one judge on one sample.** The interval includes chance, which supports "not obviously
  different" and nothing stronger. A second judge, or humans, would say more.
- **Fan comments are not DMs.** Instagram replies are public and start with a mention; a DM does neither. The card
  works around the first and the second is a known gap in the data ([PERSONA-PIPELINE.md](persona/PERSONA-PIPELINE.md#known-gaps)).
- **A crisis message that lands mid-reply is caught on the next turn**, not before the reply commits. Closing that
  costs a model call on every turn, so it waits for evidence of how often it happens
  ([SAFETY.md](safety/SAFETY.md)).
- **Partitioning is designed, not built**, and the extrapolations in [SCALING.md](operations/SCALING.md) are marked as
  such. The measured point where the hot paths degrade has not been reached.
- **The packages are not published.** They build and install from a tarball; putting them on a registry is the
  maintainer's call.
- **The operator owns the rest.** Age assurance, payments and content rules for a market are not something the code can
  decide for someone else ([SAFETY.md](safety/SAFETY.md)).
