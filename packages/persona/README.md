# @understudy/persona

Turns a creator's Instagram posts and replies into an anonymised bank, a persona card and the evals that
score it. Plain ES modules with a hand-written `index.d.ts`: no build step and no dependencies.
Needs Node 22 or newer.

## Install

The package lives in this repository's npm workspace (`packages/persona`), so `npm install` at the root links it:

```sh
npm install
npx understudy-persona --help
```

It is marked private; nothing is published to npm.

## API

```js
import { normalise, writeSplits, writeStyle, writeChunks } from "@understudy/persona";

normalise({ rawDir: "data/persona/raw", outDir: "data/persona/bank", creator: "junovale" });
writeSplits({ bankDir: "data/persona/bank", seed: "understudy-2026" });
writeStyle({ bankDir: "data/persona/bank" });
writeChunks({ bankDir: "data/persona/bank" });
```

Importing the package runs nothing. Every function takes one options object; every model call goes through an
adapter you pass in (`createClaude()`, `createJev()`), so tests inject a fake.

| Export | What it does |
|---|---|
| `synth(opts)` | generate a synthetic creator's raw records |
| `normalise(opts)` | anonymise raw records into the bank: captions, replies, profile |
| `writeSplits(opts)` | split paired replies by post: train, validation, test, style-only |
| `writeStyle(opts)` | measured style figures from train and style-only replies |
| `writeChunks(opts)` | retrieval chunks (validation and test pairs never enter) |
| `draftCard(opts)` | draft the persona card with Claude |
| `rapidEval(opts)` | Jev on the validation split: can it tell her real reply from the generated one |
| `makeQueries(opts)` | a labelled retrieval query set |
| `build(args)`, `STEPS` | run all of the above in order; a step whose output exists is skipped |
| `scrape(opts)` | collect the session's own account, its posts and the owner's own replies, over an injected GET-only client; a different `handle` throws `NotOwnAccount` |
| `resolveOwnHandle(client)`, `createClient(opts)` | which account a session belongs to; the GET-only transport |
| `readInstagramExport(path)`, `exportToRaw(opts)` | read Instagram's own data download (zip or folder) and write the raw layout; direct messages are never opened; `ZipError` for archives it refuses |
| `draftPersona(opts)`, `SECTIONS` | normalise, split, style, chunks and the card for a raw directory, with no evaluation; the card's seven sections |
| `evalPersona(opts)` | Claude judge scores and blind test over the test split |
| `leakCheck(rawDir, tree)` | find raw captions, replies or handles in a tree of files |
| `createClaude(opts)`, `createJev(opts)` | the two model adapters |
| `TokenBudget` | token cap shared by a run |

Types for every option bag and result are in [`src/index.d.ts`](src/index.d.ts).

## CLI

```
understudy-persona <build|synth|scrape|eval|leak-check> [flags]
```

Each subcommand runs the stage script of the same name and passes its flags through. The single stages
(`normalise`, `split`, `style`, `chunks`, `draft-card`, `rapid-eval`, `queries`, `add-examples`) are subcommands too.
`understudy-persona build --help` lists the steps. Paths default to `data/persona/` under the directory you run it in.
Model ids are always flags; keys come from the environment (`CLAUDE_SECRET_KEY`, `TYPESAFE_SECRET_KEY`).

## Scraping

`understudy-persona scrape` reads the Instagram account a logged-in session cookie (`IG_SESSIONID`) belongs to, GET
requests only, one at a time. A `--handle` is optional and refused unless it is that account.

Use it only on an account you own. The output contains other people's comments; keep it out of version control.

## Instagram export

`readInstagramExport` and `exportToRaw` read the data download Instagram gives an account holder (JSON format, as the
zip or its folder): the profile, her posts and reels, and the comments she wrote. Direct messages, stories and likes are
never opened. The zip reader uses node built-ins only. A download has no fan side for her comments, so a card drafted
from one uses her own lines in place of reply pairs. `@understudy/persona/testing` exports `fixtureFetch`,
`fakeCardClaude` and `writeZip` for tests.

## Tests

```sh
npm test --workspace @understudy/persona
```

The fixtures in `fixtures/` describe invented accounts. The tests never call a model or reach Instagram.
