# Data-flow diagrams

One line per flow: name, diagram, the code that implements it.

- Persona pipeline → `docs/diagrams/persona-pipeline.html` → `{packages/persona/src/**,scripts/persona/*}`
- Analytics: tables to queries to dashboard and report → `docs/diagrams/analytics.html` → `{lib/analytics/*.ts,app/analytics/**,scripts/metrics-report.ts}`
- Fan message to bubbles and typing over Pusher → `docs/diagrams/realtime.html` → `{providers/pusher/**,components/chat/live-thread.tsx,app/chat/actions.ts,lib/conversations/read.ts}`
- Takeover, hand-back, release → `docs/diagrams/human-handoff.html` → `{lib/conversations/controls.ts,app/console/actions.ts,app/admin/actions.ts}`
  - Creator offer: Juno → `sendOfferAction` → `offers` + `messages` (offer_id) → Pusher refetch → fan thread (no redraw needed)
- Engine explainer (all six diagrams, every step, threshold and failure) → `docs/diagrams/engine.html` → `{packages/engine/src/**,providers/**,lib/chat/send.ts,lib/conversations/actions.ts}`
- Engine turn: lease, settle, Jev, route, draft, verify, fold-in, commit, deliver → `docs/diagrams/engine-turn.html` → `{packages/engine/src/turn.ts,packages/engine/src/process.ts,packages/engine/src/sweep.ts,packages/engine/src/debounce.ts,packages/engine/src/lease.ts,packages/engine/src/bubbles.ts}`
- Engine routing: hard stops, intent floor, holds, pitch gate → `docs/diagrams/engine-routing.html` → `{packages/engine/src/route.ts,packages/engine/src/pacing.ts,packages/engine/src/facts.ts}`
- Boundary strikes: an off-platform ask, her line, the numbered warning, the pause on the third; a threat's one line → `docs/diagrams/engine-strikes.html` → `{packages/engine/src/route.ts,packages/engine/src/strikes.ts,packages/engine/src/turn.ts,packages/engine/src/lease.ts,packages/engine/src/templates.ts}`
- Engine verify and retry: code checks, Jev verify, retry notes, suggestion → `docs/diagrams/engine-verify.html` → `{packages/engine/src/verify.ts,packages/engine/src/questions.ts,packages/engine/src/emoji.ts,packages/engine/src/turn.ts}`
- A fan message end to end: browser, send, engine, Jev, Claude, Pusher → `docs/diagrams/engine-message.html` → `{lib/chat/send.ts,lib/chat/typing.ts,packages/engine/src/turn.ts,providers/pusher/**,components/chat/live-thread.tsx,lib/conversations/read.ts}`
- What each model sees: Jev's fenced state vs Claude's prompt → `docs/diagrams/engine-context.html` → `{packages/engine/src/prompt.ts,packages/engine/src/thread.ts,packages/engine/src/memory.ts,packages/providers/src/voyage/persona-retriever.ts}`
- Conversation modes: ai, handoffs, takeover, hand-back, release → `docs/diagrams/engine-states.html` → `{packages/engine/src/lease.ts,packages/engine/src/handoff.ts,lib/conversations/actions.ts,lib/conversations/controls.ts}`
- RAG: Juno's chunks embedded once by Voyage, each fan message embedded, nearest 5 by pgvector into Claude's prompt, keyword fallback → `docs/diagrams/rag.html` → `{packages/providers/src/voyage/**,packages/engine/src/retrieve.ts,scripts/persona/load.ts,packages/engine/src/prompt.ts}`
- Instagram scraper: web API, GET-only transport, pairing and mapping, raw layout, normalise → `docs/diagrams/scraper.html` → `{packages/persona/src/scrape/**,packages/persona/fixtures/instagram/**}`
- Platform continuity: turn to FailoverDecider (Jev, Claude) and FailoverGenerator (primary, fallback model), a breaker each → `docs/diagrams/continuity.html` → `{packages/providers/src/failover/**,packages/providers/src/anthropic/decider.ts,lib/host/deps.ts}`
- Escalation: hold filler, handoff due time, sweep settles by policy or stamps a T&S breach → `docs/diagrams/escalation.html` → `{packages/engine/src/escalation.ts,packages/engine/src/handoff.ts,packages/engine/src/sweep.ts}`
- Headless server: POST a message, engine turn, bus, server-sent bubbles and signed webhook; takeover, human reply, hand-back → `docs/diagrams/server.html` → `{examples/server/src/**,packages/engine/src/takeover.ts}`
- Data model: which table carries creator_id and which reach it through a foreign key → `docs/diagrams/data-model.html` → `{packages/engine/src/schema.ts,db/host-schema.ts,packages/engine/src/isolation.db.test.ts}`
