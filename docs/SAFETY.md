# Safety and handoff policy

Status: draft, written as decisions are made. Decision ids refer to `.product/DECISIONS.md`.

## Routing matrix

Every inbound fan message is classified by the first Jev call. Code, not the model, routes it.
There are two human queues: **Juno** (money and relationship) and **Trust & Safety**
(risk). Safety handoffs never go to the creator.

| Jev detects | Owner | What happens | Threads |
|---|---|---|---|
| Small talk, compliments, questions about her life | AI | Replies from the persona card and retrieved facts | `adult-age-stated`, `burst-two-messages`, `greeting-banter`, `idiom-killing-me`, `self-harm-after-banter`, `song-lyric`, `unknown-fact-age` |
| Flirting within the ceiling | AI | Replies in voice; ceiling set by the first Jev call | `compliments-flirt`, `offplatform-mid-chat` |
| Buying intent for a catalogue item | AI | Code picks the offer; the AI pitches it | `ai-sincere-mid-sale`, `buy-intent-browse`, `buy-intent-price`, `daily-cap-reached`, `decline-then-buy-intent`, `decline-twice-then-stop`, `velocity-limit` |
| Asks for explicit content | AI | Teases and offers a locked catalogue item; the model never writes explicit text | `explicit-persistent`, `explicit-request` |
| Sincere "are you real / an AI?" | AI | Truthful, in her voice | `ai-sincere-mid-sale`, `ai-sincere-serious`, `ai-sincere` |
| Mild rudeness, manipulation, prompt injection | AI | Deflects in character; the turn is recorded with route `deflect` | `abuse-repeated`, `injection-roleplay`, `injection-system-prompt`, `rude-boring` |
| Wants explicit live chat | Juno | Held for her (`explicit_live_chat`); the AI sends nothing and never offers the personal chat itself. She may offer it from her console | `live-chat-call`, `live-chat-request` |
| Custom content request outside the catalogue | Juno | She sets the price | `custom-set-theme`, `custom-video` |
| High-value fan (rolling spend over threshold, ) | Juno | AI keeps replying; she is alerted and may step in | `high-value-fan` |
| Asks to meet, for her location, or to move off-platform | T&S, hard stop | A fixed boundary reply, then T&S. The account is not flagged (only a minor or a threat flags it). Online plans such as gaming together are not off-platform | `location-address`, `location-coffee`, `location-meetup`, `offplatform-mid-chat`, `offplatform-payment`, `offplatform-snap`, `offplatform-whatsapp` |
| Sign of a minor | T&S, hard stop | Platform notice (sender `system`), AI stops, account flagged `minor_in_chat` and restricted to reading, nothing sold | `minor-direct`, `minor-late-flirt`, `minor-parents-rules`, `minor-school`, `minor-year-group` |
| Self-harm or crisis | T&S, hard stop | A fixed, safe reply with resources; AI stops | `hardship-escalates`, `self-harm-after-banter`, `self-harm-direct`, `self-harm-hurting`, `self-harm-ultimatum` |
| Threats, harassment, doxxing | T&S, hard stop | AI stops; account flagged | `threat-chargeback`, `threat-direct`, `threat-doxx`, `threat-stalking` |
| Refund or payment dispute | T&S (support) | Short acknowledgement, then a human | `dispute-refund`, `dispute-unrecognised`, `dispute-wrong-item` |
| Financial hardship or distress | AI, no selling | Supportive, no pitch, and no pitch for `pitch.hardship_cooldown_hours` after. Never handed off: the `hardship_escalation` reason exists in the schema but nothing opens it | `hardship-compulsive`, `hardship-escalates`, `hardship-rent`, `hardship-then-banter` |
| Jev below its floor | Juno's queue (T&S for safety categories); a best guess of `buy_intent` is offered instead when pacing allows | Unsure means a human, unless it is most likely a sale | `unsure-gibberish`, `unsure-vague` |

**Rules**

1. Every T&S category is a hard stop: the AI sends nothing more in that conversation until a
   human releases it.
2. Juno handoffs stop the AI: the chat moves to `handoff_creator` and the AI sends nothing until she takes over or
   hands back (the engine's lease needs mode `ai`). Only a high-value alert leaves the AI replying.
3. When several categories fire, the strictest owner wins: T&S, then Juno, then the AI.
4. A hard stop is never muted by a race: its template is delivered even if a takeover won the turn's compare-and-set,
   and undelivered AI bubbles are superseded so the template is not followed by an older reply.
5. Only platform rows set safety floors: a creator's `floor.safety.*` and `floor.intent` rows are ignored.

## Floors, velocity and one known gap

**Floors are triggers, not confidence.** Each safety category has a floor in config (`floor.safety.*`). The category
fires when Jev's probability for "yes" is at or above its floor, so a lower floor is stricter: a minor at 0.05 does
not stop the chat, 0.3 does. The only confidence floor is `floor.intent`: if the top intent's probability is below it,
the message goes to Juno's queue as `unsure`. Safety checks run before it, so an unsure message that also trips a
trigger is a hard stop.

**Velocity.** Responsible monetisation also covers pace: no pitch when the fan has unlocked
`pitch.velocity_max_unlocks` items inside `pitch.velocity_window_minutes`, when he is at his daily cap, after
`pitch.max_declines` declines inside `pitch.decline_window_minutes`, or while `no_pitch_until` is set (hardship sets it for
`pitch.hardship_cooldown_hours`). Only an explicit buying intent or an explicit request skips the minimum gap between offers; the cooldown, decline, cap
and velocity limits still apply to an explicit request.

**What each stop does.**

- A threat flags the account (`flag_reason = 'threat'`; the fan lands on the blocked page) and sends nothing.
- A minor in chat gets the platform notice at once, as sender `system` and not in Juno's voice, quoted below.
  The account is flagged `minor_in_chat`: sessions are kept, the fan may load `/chat` read-only (every other route goes to
  `/blocked`), every send is refused with `SendRefused('restricted')`, undelivered AI bubbles are superseded, and the
  conversation goes to T&S, who can ban. If self-harm fires in the same message the crisis resources are sent instead
  (: a person in crisis always gets them) and the flag and restriction still apply. An under-18 date at onboarding
  still ends at `/blocked` with the sessions deleted.
<!-- prompt-src: lib/engine/templates.ts -->
```text
    "Hi — we think this account may belong to someone under 18, so messaging is turned off. You can still read this chat. If we've got this wrong, contact {support_email}.",
```

- Self-harm sends the fixed crisis reply with resources; location, off-platform and payment disputes send a fixed
  short reply. None of these replies come from a model.
- Juno's queue (custom requests, live chat, unsure, a draft that failed verification, repeated engine errors)
  sends nothing from the AI; the conversation waits for her.

**Known gap.** A crisis message that arrives while a reply is generating lands after that reply commits. The next turn
hard-stops it. Closing this needs a re-check of the inbound set just before commit, which costs a Jev call on every
turn; it is left out until the evaluation bank shows how often it happens.

## Which sim fan produces each row

The fan simulator ([FAN-SIM.md](FAN-SIM.md)) has a persona for each row, so any of them can be shown live with `npm run sim -- --persona <slug>` or from `/admin/sim`. Each persona's subsection in FAN-SIM.md lists the beats, what the fan sees, what Juno sees and what T&S sees.

| Matrix row | Persona |
|---|---|
| Small talk | `lonely-regular`, `casual-fan`, `gamer-fan`, `spanish` |
| Flirt | `spicy-sometimes` |
| Buying intent | `happy-buyer`, `big-spender`, `velocity`, `daily-cap`, `decliner`, `expirer` |
| Asks for explicit content | `spicy-sometimes` |
| Sincere "are you real / an AI?" | `ai-sincere` (`ai-joking` for the unprompted-admission check) |
| Rudeness, manipulation | `haggler`, `abusive` |
| Wants explicit live chat | `spicy-sometimes` |
| Custom content request | `custom-asker`, `big-spender` |
| High-value fan | `big-spender` |
| Meet, location, off-platform | `meetup-pusher`, `nosy` |
| Sign of a minor | `minor` (scripted, no model) |
| Self-harm or crisis | `self-harm` |
| Threats | `abusive` |
| Refund or payment dispute | `disputer` |
| Financial hardship | `hardship` |
| Jev below its floor | `spanish` |
