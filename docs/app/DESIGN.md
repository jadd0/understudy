# Design system

Source: the founder's chat design, claude.ai/code/artifact/0e4e6819-e8dd-40a3-9937-2fe29bdad60c
(Desktop 1440×900 and Mobile 390×844 artboards). The fan chat reproduces it; every other screen
reuses its tokens and components. A screen never introduces a colour, radius or font of
its own: add a token here first.

## Tokens (`examples/app/app/globals.css` `@theme`)

| Token | Value | Use |
|---|---|---|
| `font-sans` | Geist 400/500/600 (`next/font`) | everything |
| `ground` | `#ffffff` | page |
| `ink` / `ink-2` | `#0A0A0B` / `#3D3D45` | text, primary button / its hover |
| `muted` / `muted-2` | `#6B6B73` / `#55555D` | secondary text (both ≥ 4.5:1 on white) |
| `line` / `line-2` / `line-focus` | `#ECECEF` / `#E4E4E8` / `#B9B9C2` | dividers, composer border, other fields |
| `surface` / `surface-2` | `#F1F1F3` / `#F7F7F9` | their bubble, search, active row / the tip panel's amount field |
| `tip` / `tip-ink` | `#FFC83D` / `#231900` | the composer Tip button, the tip card, the panel's send button |
| `scrim` | `rgba(5,5,10,.5)` | behind the phone tip sheet |
| shadows `panel` / `sheet` | desktop popover / phone sheet | tip panel |
| `hover` / `hover-2` | `#F4F4F6` / `#F6F6F8` | icon button, thread row hover / other quiet hovers |
| `accent` | `#3D5AFE` | my bubble, "typing…", Send, unread badge |
| `online` / `like` | `#16A34A` / `#E11D48` | presence dot, reaction heart |
| `danger` | `#C81E1E` (dark `#F87171`) | form errors, Sign out |
| `raised` | `#FFFFFF` (dark `#17171D`) | tip panel and account menu surface |
| `track` | `#D4D4DA` (dark `#3A3A44`) | the dark-mode switch, off |
| radii | bubble 20 (joined side 6), pill 28, field 12, row 14; thread row 14, tip card 22, tip panel 26, sheet 28 | |

Avatar colour pairs (bg/fg) are the design's six, picked by a stable hash of the name.

## Components (`examples/app/components/ui/`)

| Component | From the design |
|---|---|
| `Avatar` (xs 28, tip 36, sm 38, md 42, lg 52, xl 84; online dot) | yes |
| `IconButton` (44px round; `accent` = camera) | yes |
| `Button` (primary ink pill, secondary, quiet accent) | derived: the selected-tab pill and "Send" |
| `Field`, `FormAlert`, `SoloPage` | derived: the search field |
| `chat/ThreadList` (320px sidebar, resizable 260-480, 72px header with a bottom rule, 20px title, 40px search, 48px avatars, tabs, rows with time, "typing…" preview, unread count and a status badge, the account block at the bottom) | yes; badge and tabs added for the console |
| `chat/ResizableSidebar`, `chat/AccountMenu` | yes: a drag handle on the sidebar's right edge (`role="separator"`, arrow keys step 16, double-click or Home resets to 320, width kept per browser in `localStorage`); the account block opens a menu with the Dark mode switch and Sign out (Auth.js `signOut`), backdrop click or Escape closes it |
| `chat/ChatHeader`, `chat/ChatIntro` | yes |
| `chat/MessageList` + `TypingRow` | yes: hover time (desktop), "Seen"/"Sent" line, entrance animation, the yellow tip card; grouping in `examples/app/lib/ui/group-messages.ts`, tip rows read by `examples/app/lib/ui/tip-message.ts` (both tested) |
| `chat/Composer` (pill, yellow Tip button while empty, filled Send with a draft) | yes |
| `examples/app/components/chat/TipSheet` (desktop popover, phone bottom sheet with scrim) | yes: preset chips from config; the note field's slot holds a custom amount, because the tip action carries no note |
| `chat/LockedCard` (paid message) | derived from the tokens: bubble radius, surface, ink button |
| `Badge` (neutral, accent, ink; `badgeTone` picks one per inbox label) | derived: the thread-row chip, tokens only |
| `Switch` (a submit button with `role="switch"`, no client script) | derived: the design's accent for on, `line-focus` for off |
| `chat/ThreadList` `fullOnMobile` | the inbox index fills a phone; thread pages keep it desktop-only |
| `examples/app/components/chat/LiveThread` (client) | the fan chat reproduces the design; the same component hosts the console and admin thread with a takeover bar and suggested-reply card in the kit's surface and pill styles |
| `examples/app/components/console/Inbox` (server) | ThreadList with filter tabs All, Needs you, AI |
| `skeleton.tsx` (`Skeleton`, `SkeletonLine`, `SkeletonAvatar`, `SkeletonRow(s)`, `SkeletonBubble`, `SkeletonField`, `SkeletonGroup`) | derived: surface-filled blocks in the kit's radii, see Loading states |
| `icons.tsx` | the design's stroke icons, plus lock and wallet in the same style |

## Rules carried from the design

- Bubbles in a run join on the sender's side; only the last bubble of a "them" run shows the avatar; a 30-minute gap or a new day inserts a time separator.
- Phone width: the sidebar and the opening avatar block hide, the header gets a back link, bubbles go to 76% width (desktop `min(66%, 480px)`), the composer input is 16px (no iOS zoom), the tip panel becomes a bottom sheet.
- Copy as drawn, with `$` for the artboard's `£` (the product is USD). Not built because there is no data: the heart reaction, "You subscribed [DATE]".
- Touch targets ≥ 44px; icon-only buttons carry `aria-label`; typing dots stop under `prefers-reduced-motion`.

## Preview

`/dev/ui-kit` (development only, 404 in production) renders the kit as the chat design with demo data.

## Screens

`docs/app/screens/` holds 1440 and 390 captures of chat (with and without the tip panel open), wallet, console, console thread, settings, admin, the fan simulator (`admin-sim`), analytics (creator and admin views, one turn), and at 1440 the dark theme and the account menu. Every signed-in page shows the top navigation bar. Tabs
reuse the ThreadList tab pills, so no separate `Tabs` component was added.

## Dark mode, resize and motion

- Dark mode: the account menu's switch toggles `dark` on `<html>`; the design's `.app.dark` values override the same token names in `examples/app/app/globals.css`. The choice is in `localStorage` (`theme`) and a script in the root layout's `<head>` applies it before first paint, so there is no flash. Default light.
- Sidebar width: 320 by default, 260 to 480, clamped by `examples/app/lib/ui/sidebar-width.ts`. The width is the CSS variable `--sidebar-w` on `<html>`, set before paint from `localStorage` (`sidebar-width`), so the first paint is already at the stored width. Storage that throws leaves 320 and light.
- Tip panel and sheet: pop-in (about 500ms with a small overshoot) and pop-out (200ms popover, 220ms sheet); the panel stays mounted with `data-closing` until the out animation ends, content fades up, the Tip button bumps while the panel is open, the scrim fades out. Sending a tip closes the panel, and the tip card arrives with the thread refresh. The account menu pops in the same way (240ms in, 160ms out). Under `prefers-reduced-motion` the animations stop and the closing panel only fades.

## Loading states

Every signed-in page is streamed server rendering: the top bar, headings, frames and static controls arrive at
once, and each section that reads the database sits in its own `<Suspense>` with a skeleton, streaming in when its
query finishes. All data is still read on the server; there is no client fetching layer.

- **Kit** (`examples/app/components/ui/skeleton.tsx`): `bg-surface` blocks (`strong` = `line-2` on a surface card) in the kit's
  radii (`rounded-bubble`, `rounded-field`, `rounded-row`, `rounded-full`). They pulse (`animate-pulse`) and stand still
  under `prefers-reduced-motion`. Blocks are `aria-hidden`; each loading section is one `SkeletonGroup`
  (`aria-busy`, one sr-only "Loading …" status).
- **Sizes are the real ones.** A text placeholder is a bar centred in a box the height of the real line
  (`SkeletonLine lineHeight`), so headings below a section do not move when it arrives: thread rows 68px, ledger
  rows 67px, a `Field` 93.5px, the chat header 65 / 69.5px, the composer pill 52 / 54px.
- **Real frame, placeholder rows.** `ThreadList pending={n}` keeps the title, search, tabs and account block and only
  swaps the rows; `InboxSkeleton` and `ChatSkeleton` are built on it. `ThreadSkeleton` is `LiveThread`'s column.
- **Where they show**: each section's Suspense fallback on a full load, and the route's `loading.tsx` (the same
  skeletons in the same frame) during client navigation. The thread pages (/console/[id], /admin/[id]) are the
  exception: their inbox renders with the shell and only the thread streams, so switching threads never blanks the
  list. A refresh (realtime event, the simulator's ticker) is a
  transition and keeps the content on screen; skeletons never flash on a refresh.

