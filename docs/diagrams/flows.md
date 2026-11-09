# Data-flow diagrams

One line per flow: name, diagram, the code that implements it.

- Persona pipeline → `docs/diagrams/persona-pipeline.html` → `scripts/persona/*`
- Analytics: tables to queries to dashboard and report → `docs/diagrams/analytics.html` → `{lib/analytics/*.ts,app/analytics/**,scripts/metrics-report.ts}`
- Fan message to bubbles and typing over Pusher → `docs/diagrams/realtime.html` → `{providers/pusher/**,components/chat/live-thread.tsx,app/chat/actions.ts,lib/conversations/read.ts}`
- Takeover, hand-back, release → `docs/diagrams/human-handoff.html` → `{lib/conversations/controls.ts,app/console/actions.ts,app/admin/actions.ts}`
  - Creator offer: Juno → `sendOfferAction` → `offers` + `messages` (offer_id) → Pusher refetch → fan thread (no redraw needed)
- Engine explainer (all six diagrams, every step, threshold and failure) → `docs/diagrams/engine.html` → `{lib/engine/**,providers/**,lib/chat/send.ts,lib/conversations/actions.ts}`
- Engine turn: lease, settle, Jev, route, draft, verify, fold-in, commit, deliver → `docs/diagrams/engine-turn.html` → `{lib/engine/turn.ts,lib/engine/process.ts,lib/engine/sweep.ts,lib/engine/debounce.ts,lib/engine/lease.ts,lib/engine/bubbles.ts}`
- Engine routing: hard stops, intent floor, holds, pitch gate → `docs/diagrams/engine-routing.html` → `{lib/engine/route.ts,lib/engine/pacing.ts,lib/engine/facts.ts}`
- Engine verify and retry: code checks, Jev verify, retry notes, suggestion → `docs/diagrams/engine-verify.html` → `{lib/engine/verify.ts,lib/engine/questions.ts,lib/engine/emoji.ts,lib/engine/turn.ts}`
- A fan message end to end: browser, send, engine, Jev, Claude, Pusher → `docs/diagrams/engine-message.html` → `{lib/chat/send.ts,lib/chat/typing.ts,lib/engine/turn.ts,providers/pusher/**,components/chat/live-thread.tsx,lib/conversations/read.ts}`
- What each model sees: Jev's fenced state vs Claude's prompt → `docs/diagrams/engine-context.html` → `{lib/engine/prompt.ts,lib/engine/thread.ts,lib/engine/memory.ts,providers/voyage/persona-retriever.ts}`
- Conversation modes: ai, handoffs, takeover, hand-back, release → `docs/diagrams/engine-states.html` → `{lib/engine/lease.ts,lib/engine/handoff.ts,lib/conversations/actions.ts,lib/conversations/controls.ts}`
- RAG: Juno's chunks embedded once by Voyage, each fan message embedded, nearest 5 by pgvector into Claude's prompt, keyword fallback → `docs/diagrams/rag.html` → `{providers/voyage/**,lib/persona/retrieve.ts,scripts/persona/load.ts,lib/engine/prompt.ts}`
