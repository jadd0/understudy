# Console and Trust & Safety

## Who sees what

| | Creator (`/console`) | Admin (`/admin`) | Fan (`/chat`) |
|---|---|---|---|
| Conversations | her own, except any on the Trust & Safety side | every conversation, T&S ones first | their own with the creator they open (`/chat?c=<handle>`) |
| Settings | AI switch, never-list, catalogue (add, price, reorder, retire), persona card (read-only) | the same page for the platform creator, through `/console/settings`; no actor is recorded | none |
| Actions | take over, reply, edit and send a suggestion, discard, hand back, per-chat AI switch, send an offer | take over (any chat), reply, edit and send a suggestion, discard, release, ban (on `/admin/[id]` only) | send, unlock, tip, typing pings |
| Turn labels (route, outcome, ms, cost) | on hover over an AI bubble | same | never |

Navigation lives in the top bar (`examples/app/components/ui/app-shell.tsx`, links from `examples/app/lib/ui/app-nav.ts`): a creator gets Inbox,
Settings and Analytics; an admin gets Safety queue, Console, Simulator and Analytics. The inbox header shows only the
seat label.

**Admins in the console.** An admin may open `/console`. Its inbox there is the same all-conversations list
(scope `true`, no tabs, filter ignored); settings apply to the platform creator (`consoleCreatorFor` → `primaryCreator`).
In a thread it can refresh, reply, take over (to `human_ts`), release and send or discard a suggestion. Hand-back,
the per-chat AI switch and offers stay creator-only, and ban is only on `/admin/[id]`.

## Viewer scoping

Every read takes a viewer `{ id, role }` from the session and is filtered by one function, `scopeFor`, in
`examples/app/lib/conversations/read.ts`. A creator sees her conversations where the mode is not `handoff_ts` or `human_ts` and
there is no unresolved `ts` handoff; an admin sees every conversation, T&S ones listed first; a fan sees their own. A
conversation outside the scope is `ConversationNotFound`, which pages turn into a 404, so a creator cannot tell a
T&S conversation from one that does not exist. Controls call the same function before acting.

Proof: `examples/app/lib/conversations/read.db.test.ts` (`creator_never_lists_ts_conversation`,
`creator_getThread_on_ts_conversation_throws_not_found`, `admin_lists_every_conversation_with_ts_first`) and
`examples/app/app/api/pusher/auth/route.db.test.ts` (`creator_cannot_auth_ts_conversation`) for the realtime door.

## Controls

| Control | Writes | The engine reads it |
|---|---|---|
| Global AI switch | `creator_settings.ai_enabled` (engine table; no row means on) | `acquireLease` checks it at the start of every turn |
| Per-conversation AI switch | `conversations.ai_enabled` | same lease check |
| Never-talk-about list | `persona_cards.never_list` on her newest published version | each turn loads the newest published card and verifies the draft against it |
| Catalogue price | `catalogue_items.price_cents` (integer cents, above zero) | the next offer copies it; an open offer keeps the price it copied |
| Catalogue item added | a new `catalogue_items` row for her creator (kind ppv, bundle or personal; title up to 80 characters; teaser up to 200; the price typed in dollars and converted to cents once, in the action) at the end of her order | the shortlist reads active rows only, ordered by price, so a new item is offered like any other |
| Catalogue order | `catalogue_items.position`; a move swaps an item with its neighbour among the active ones and renumbers every item of hers 0..n-1 in one transaction that locks only her catalogue rows | the console list and the offer picker (`position`, then title); the engine's shortlist keeps its own price order |
| Catalogue retire and restore | `catalogue_items.active` (rows are never deleted: offers and unlocks point at them) | the shortlist and the offer picker skip a retired item; an offer already open on it can still be unlocked until it expires |
| Persona card | read-only here (newest published version) | the engine reads the newest published version |

None of these is a `config` row: the engine reads the tables above, so they take effect on the next message with no
cache. A persona reload creates a new card version whose never-list is parsed from the card text, so an edit made
here lasts only until the next reload; put the term in the card as well.

## The due time on a queue row

A row whose chat has an open handoff shows a quiet line under the preview. In the creator's inbox: "Auto-resolves in N min"
while the handoff is unclaimed, due, and its reason is in `escalation.auto_resolve_reasons`; "Auto-resolving now" once past
due (the next sweep settles it); nothing for a reason a person must handle. In the admin's Safety queue: "Waiting 12m",
with "· late" once the handoff passed `escalation.ts_sla_minutes`. Taking the chat over claims the handoff and the line goes.

## Takeover, hand-back, release, ban

1. **Take over** (`takeOverConversation` → `takeover`): one transaction locks the conversation, sets mode
   `human_creator` (or `human_ts` for an admin, from any mode), bumps `version` so a turn in flight fails its
   compare-and-set, drops the lease, claims the open handoff, and supersedes AI bubbles the fan has not yet seen.
   A creator is refused on the T&S side. An admin may take over any conversation, including one another admin holds.
2. **Reply** (`sendAsCreator`): only in the viewer's own human mode; stored as sender `creator` or `admin`. A
   never-list term in a human's words is allowed.
3. **Suggested reply** (`sendSuggested`): the AI's held draft (`suggested=true`, status `blocked`) is edited and
   sent as the human's own message; it takes the conversation over first if it is not already. `discardSuggested`
   drops it.
4. **Hand back** (`handBackConversation` → `handBack`): the creator returns her own conversation to `ai`; fan
   messages still waiting are stamped with a sentinel turn so the AI does not answer what a human handled.
5. **Release** (`releaseConversation`, admin only): resolves the T&S handoff, or with none hands back a chat an admin took over directly, and returns it to the AI. An open or claimed handoff can be released; a resolved one is refused (`ConversationNotFound`) and nothing changes.
6. **Ban** (`ban`, admin only, fans only): sets `users.flagged_at` and deletes the user's sessions, as the under-18
   path does. The next request resolves to `/blocked`, and `sendFanMessage` refuses a flagged fan.

7. **Offer** (`sendOfferAsCreator`, creator only): while the chat is `human_creator`, the staff bar shows an
   "Offer an item" picker of her active catalogue items (title, kind, catalogue price) and a Send offer button.
   One transaction locks the conversation, re-checks the mode, reads the item's price from the catalogue row
   (the client sends only the item id), inserts the `offers` row (expiry from `offer.ttl_minutes`, `turn_id` null)
   and a `creator` message carrying `offer_id`, then announces `message.created`. The fan unlocks it through
   `unlockOffer` like an engine offer. Refused (`Forbidden`, shown as "That is not available to you.") when the viewer
   is not the owning creator (admins get no control), the chat is not `human_creator` (a hand-back between opening
   the picker and sending refuses it), the item is another creator's or inactive, or the same item already has an
   open unexpired offer in this conversation.

`handBack` itself takes no actor, so every caller checks the viewer first (tested: `creator_cannot_call_release_or_ban`).

## Restricted fans

A fan flagged `minor_in_chat` is restricted, not blocked. `/chat` and its refresh action use `requireChatReader`
(route `chatRead` in `examples/app/lib/auth/guards.ts`): the full history shows read-only, `system` messages render as a centred
platform notice rather than an Juno bubble, the unlock button is gone, and the composer is replaced by "Messaging
is turned off for this account." Sessions are kept, so `/` lands on `/chat`. Every other route, including `chat`
itself (so sends and unlocks) and `/wallet`, stays `/blocked`, as does any fan flagged for another reason, an
under-18 date at onboarding included. The engine side (the notice, setting the flag, refusing sends) is built:
`flagUser` in `packages/engine/src/conversation/lease.ts` and the `restricted` refusal in `examples/app/lib/chat/send.ts`.
Proof: `minor_in_chat_fan_reads_chat_read_only` in `examples/app/lib/auth/guards.db.test.ts`.

A restricted fan cannot authorise a private Pusher channel (the auth route refuses flagged users), so their read-only
chat refreshes by a 30 s poll instead. Their wallet icon and tip button are hidden.

## Tips

The fan chat has a "Tip" button above the composer: presets from `wallet.tip_options_cents`, a custom amount, and a
minimum from `wallet.tip_min_cents` (both `config` rows, seeded by `examples/app/db/seed.ts`; an existing database needs
`npm run db:seed`). `tipAction` (`examples/app/app/chat/actions.ts`) takes the fan from the session, finds their own conversation
with Juno, calls `examples/app/lib/wallet/tip.ts` with a client idempotency key and the conversation id, then posts a `system`
row "You tipped $5.00" keyed by the same key, so a retry charges and posts once. The engine does not thank on its
own, so no thank-you from Juno follows; she sees the same row in her console as a platform note. Flagged and
restricted fans are redirected to `/blocked` by the guard before the action runs.
Proof: `examples/app/app/chat/actions.db.test.ts`.
