"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChatHeader, ChatIntro } from "@/components/ui/chat/chat-header";
import { Composer } from "@/components/ui/chat/composer";
import { LockedCard } from "@/components/ui/chat/locked-card";
import { MessageList } from "@/components/ui/chat/message-list";
import {
  ThreadList,
  type ThreadSummary,
} from "@/components/ui/chat/thread-list";
import { shortAge } from "@/lib/ui/inbox-badge";
import { TYPING_PING_INTERVAL_MS } from "@/lib/chat/typing-window";
import { typingHoldMs } from "@/lib/ui/typing-delay";
import { TipSheet } from "./tip-sheet";
import { Switch } from "@/components/ui/switch";
import type { Snapshot, ThreadMessage } from "@/lib/conversations/read";
import { formatCents } from "@/lib/wallet/money";
import { groupMessages } from "@/lib/ui/group-messages";
import {
  applyChanges,
  mergeOlder,
  mergeSnapshot,
  reconcilePending,
  type PendingMessage,
} from "@/lib/ui/thread-window";
import type { WindowCursors } from "@/lib/conversations/window";
import { parseTipMessage } from "@/lib/ui/tip-message";
import {
  conversationChannel,
  creatorChannel,
  TS_CHANNEL,
} from "@/providers/pusher/channels";
import { REASON_TEXT, type ActionResult, type OfferChoice, type ThreadActions } from "./types";
import { useRealtime } from "./use-realtime";

type Role = "fan" | "creator" | "admin";

const subscribeNever = () => () => {};
const REALTIME = Boolean(
  process.env.NEXT_PUBLIC_PUSHER_KEY && process.env.NEXT_PUBLIC_PUSHER_CLUSTER,
);
const POLL_FALLBACK_MS = 3000;
/** A restricted fan cannot authorise a private channel, so their read-only chat refreshes slowly instead. */
const READ_ONLY_POLL_MS = 30_000;
const POLL_WHILE_AI_MS = 2500;
/** Pad a scheduled refetch past the bubble's due time: the database clock decides what is visible. */
const DUE_SLACK_MS = 500;
/** Within this distance of the bottom the reader counts as following the chat, so new bubbles scroll into view. */
const NEAR_BOTTOM_PX = 80;
/** Start loading the older page a little before the top of the list is reached. */
const OLDER_PREFETCH_PX = 240;

/**
 * One open conversation, live. The server renders the first snapshot; after that, any event (or a timer for a
 * bubble that is not due yet, or a poll when Pusher is not configured) syncs it. Events never carry text, and rows
 * are keyed by message id, so a late event cannot duplicate a bubble.
 *
 * Windowed, when the snapshot carries `window`: the first load is the newest page, older pages load as the
 * reader scrolls up (`actions.older`), and a sync reads only what changed since the sync cursor (`actions.changes`)
 * and upserts it into the held messages. Legacy, without `window`: every sync refetches and replaces the whole snapshot.
 */
export function LiveThread({
  role,
  initial,
  actions,
  header,
  creatorId,
  introLine,
  walletHref,
  readOnlyNotice,
  tipOptions,
  sidebar,
  offerItems,
}: {
  role: Role;
  /** A windowed snapshot carries `window`; a whole one does not. */
  initial: Snapshot & { window?: WindowCursors };
  actions: ThreadActions;
  header: { name: string; backHref?: string; actions?: ReactNode };
  creatorId: string;
  introLine?: string;
  walletHref?: string;
  /** Set for a restricted fan: the thread is history only and the composer is replaced by this line. */
  readOnlyNotice?: string;
  /** Preset tip amounts and the minimum, read from config by the page; omitted when the fan may not tip. */
  tipOptions?: { presets: number[]; minCents: number };
  /** The creator's active catalogue items, for the Offer control; omitted everywhere else. */
  offerItems?: OfferChoice[];
  /** The fan's conversation list; its preview and time follow the live thread, not the page load. */
  sidebar?: {
    title: string;
    thread: Omit<ThreadSummary, "preview" | "time" | "typing">;
    action?: ReactNode;
    account?: { name: string; roleLabel: string };
  };
}) {
  const [snap, setSnap] = useState<Snapshot>(initial);
  // Fixed at load: a windowed view merges every read into the messages it holds, a legacy one replaces them.
  const [windowed] = useState(() => initial.window !== undefined);
  // The next older page, or null at the start of the chat (and always null when this view cannot page).
  const [olderCursor, setOlderCursor] = useState<string | null>(() =>
    actions.older ? (initial.window?.olderCursor ?? null) : null,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  // His latest send, while her typing row is still held back after it. A fresh object per send, so a
  // second send restarts the hold and the first send's timer cannot end it early.
  const [sendHold, setSendHold] = useState<{ at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  const [busy, startTransition] = useTransition();
  const seq = useRef(0);
  const applied = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  // Read and advanced only by syncs, never during render.
  const syncCursor = useRef<string | null>(initial.window?.syncCursor ?? null);
  const olderInFlight = useRef(false);
  // Whether the reader is at the bottom, kept by the scroll handler; new bubbles only scroll the view when true.
  const atBottom = useRef(true);
  // Set just before an older page is committed: the list's height, to carry the scroll position across the prepend.
  const anchor = useRef<{ height: number } | null>(null);
  // The first pin to the bottom has happened; until then the top sentinel would see itself and load a page early.
  const [pinned, setPinned] = useState(false);
  const convId = snap.thread.conversation.id;

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    // A read older than one already applied is dropped, so a slow response cannot roll the view back.
    const accept = () => {
      if (mine < applied.current) return false;
      applied.current = mine;
      return true;
    };
    const since = syncCursor.current;
    if (since !== null && actions.changes) {
      try {
        const changes = await actions.changes(since);
        if (!accept()) return;
        syncCursor.current = changes.syncCursor;
        setSnap((s) => applyChanges(s, changes));
        // A pending bubble goes as soon as the server holds the same message (matched by the id the browser gave
        // it), so the fan never sees it twice, however the send and the syncs interleave.
        setPending((p) => reconcilePending(p, changes.upserts, mine));
        return;
      } catch {
        // Fall back to a whole refresh below.
      }
    }
    try {
      const next: Snapshot & { window?: WindowCursors } = await actions.refresh();
      if (!accept()) return;
      if (windowed) {
        // Merged, not replaced, so the older pages already loaded stay on screen.
        if (next.window) syncCursor.current = next.window.syncCursor;
        setSnap((s) => mergeSnapshot(s, next));
      } else {
        setSnap(next);
      }
      setPending((p) => reconcilePending(p, next.thread.messages, mine));
    } catch {
      // A failed poll leaves what is on screen; the next event or tick tries again.
    }
  }, [actions, windowed]);

  // A timer per bubble that is not due yet: refetch just after it should appear.
  const pendingKey = snap.thread.pendingMs.join(",");
  useEffect(() => {
    const timers = snap.thread.pendingMs.map((ms) =>
      setTimeout(refresh, ms + DUE_SLACK_MS),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, refresh]);

  const channels = useMemo(
    () => [
      ...(convId ? [conversationChannel(convId)] : []),
      ...(role === "creator" ? [creatorChannel(creatorId)] : []),
      ...(role === "admin" ? [TS_CHANNEL] : []),
    ],
    [convId, creatorId, role],
  );
  const aiPending = snap.thread.aiPending;
  useRealtime(
    readOnlyNotice ? [] : channels,
    refresh,
    readOnlyNotice
      ? READ_ONLY_POLL_MS
      : aiPending
        ? POLL_WHILE_AI_MS
        : REALTIME
          ? null
          : POLL_FALLBACK_MS,
  );

  // Releases the typing row once the hold after his latest send has run out.
  useEffect(() => {
    if (!sendHold) return;
    const timer = setTimeout(
      () => setSendHold((h) => (h === sendHold ? null : h)),
      typingHoldMs(sendHold.at, Date.now()),
    );
    return () => clearTimeout(timer);
  }, [sendHold]);

  // Typing shows while she owes him an answer (his unconfirmed message, an open turn, or bubbles not yet due) until
  // the last bubble is due, but never sooner than TYPING_AFTER_SEND_MS after he sends. A reply that is already
  // visible when the hold ends leaves nothing owed, so the row never flashes.
  const typing =
    role === "fan" &&
    !readOnlyNotice &&
    sendHold === null &&
    (aiPending || snap.thread.pendingMs.length > 0 || pending.length > 0);

  const side = (m: ThreadMessage): "me" | "them" | "system" =>
    m.sender === "system"
      ? "system"
      : (m.sender === "fan") === (role === "fan")
        ? "me"
        : "them";
  const rows = useMemo(() => {
    // A saved message keeps the id the browser gave it, so the pending bubble it replaces is the same row
    // (no remount, no second entrance animation).
    const server = snap.thread.messages.map((m) => ({
      id: m.clientMsgId ?? m.id,
      side: side(m),
      text: m.body,
      at: new Date(m.at),
      tip: parseTipMessage(m.sender, m.body)?.amount,
      // The fan sees an admin's message as Understudy support, not as the creator; staff see their own "T&S" label.
      support: role === "fan" && m.sender === "admin",
    }));
    const saved = new Set(snap.thread.messages.map((m) => m.clientMsgId));
    const local = pending
      .filter((p) => !saved.has(p.id))
      .map((p, i) => ({
        id: p.id,
        side: "me" as const,
        text: p.text,
        at: new Date(p.at + i),
      }));
    const grouped = groupMessages([...server, ...local], new Date());
    // Clock times depend on the viewer's timezone, so the server render leaves them empty.
    return mounted
      ? grouped
      : grouped.map((r) =>
          r.kind === "separator" ? { ...r, label: "" } : { ...r, time: "" },
        );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.thread.messages, pending, mounted, role]);

  // New rows animate in; the first render's rows and the rows of older pages (history, not news) never do.
  const [settled, setSettled] = useState(() => new Set(rows.map((r) => r.key)));
  const freshKeys = useMemo(
    () => new Set(rows.filter((r) => !settled.has(r.key)).map((r) => r.key)),
    [rows, settled],
  );

  // One older page at a time. The cursor only moves when a page lands, so a failed read is retried on the next
  // time the top of the list comes into view.
  const loadOlder = useCallback(async () => {
    const before = olderCursor;
    if (before === null || !actions.older || olderInFlight.current) return;
    olderInFlight.current = true;
    setLoadingOlder(true);
    try {
      const page = await actions.older(before);
      const el = scroller.current;
      if (el) anchor.current = { height: el.scrollHeight };
      // Staff pages get the page's turn labels too; they are merged, so labels already shown stay.
      setSnap((s) => ({
        ...s,
        thread: { ...s.thread, messages: mergeOlder(s.thread.messages, page.messages) },
        labels: page.labels ? { ...s.labels, ...page.labels } : s.labels,
      }));
      setSettled((k) => new Set([...k, ...page.messages.map((m) => m.clientMsgId ?? m.id)]));
      setOlderCursor(page.olderCursor);
    } catch {
      anchor.current = null;
    } finally {
      olderInFlight.current = false;
      setLoadingOlder(false);
    }
  }, [olderCursor, actions]);

  // Scroll anchoring for a prepended page: everything that changed height sits above the reader (the new messages,
  // the top slot giving way to the intro at the start of the chat), so moving scrollTop by the change in scrollHeight keeps the bubble they were reading
  // where it was. Runs before paint, so the jump is never seen. Keyed on the loading row too, so a page that added
  // nothing new still clears the anchor in the commit that removes the row.
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    // Relative, so a reader still scrolling with momentum keeps the distance moved since the height was taken.
    el.scrollTop += el.scrollHeight - a.height;
  }, [rows, loadingOlder]);

  useEffect(() => {
    const el = scroller.current;
    // A reader who has scrolled up to read history is never pulled down by a new bubble.
    if (!el || !atBottom.current) return;
    // After layout settles (fonts, the offer card), pin the view to the newest bubble.
    const frame = requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight });
      setPinned(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [rows.length, typing]);

  // The top sentinel loads the next older page when it scrolls into view. A new observer per cursor reports at once
  // whether the sentinel is still visible after a page lands, so a short window keeps filling the screen.
  useEffect(() => {
    const root = scroller.current;
    const target = sentinel.current;
    if (!pinned || !root || !target || olderCursor === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadOlder();
      },
      { root, rootMargin: `${OLDER_PREFETCH_PX}px 0px 0px 0px` },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [pinned, olderCursor, loadOlder]);

  const offers = useMemo(
    () => new Map(snap.thread.messages.map((m) => [m.clientMsgId ?? m.id, m])),
    [snap.thread.messages],
  );
  const otherName =
    role === "fan"
      ? snap.thread.conversation.creatorName
      : snap.thread.conversation.fanName;
  // Only the creator has a photo; a fan shows initials to staff.
  const otherImage = role === "fan" ? snap.thread.conversation.creatorImage : null;

  async function run(fn: () => Promise<ActionResult>) {
    setError(null);
    const res = await fn();
    if (!res.ok) setError(res.error);
    await refresh();
  }

  async function send(text: string) {
    const id = crypto.randomUUID();
    setError(null);
    // His own message always brings the view down to it.
    atBottom.current = true;
    const at = Date.now();
    setPending((p) => [...p, { id, text, at }]);
    setSendHold({ at });
    const res = await actions.send(id, text);
    if (!res.ok) {
      setPending((p) => p.filter((x) => x.id !== id));
      setError(res.error);
      return;
    }
    // Read now, not inside the updater: React may run the updater after refresh() below has already taken the next
    // sequence number, and then that refresh would keep the bubble. A staff message carries no client id to match
    // on, so this is what clears it, and the bubble showed twice until the next event.
    const afterSeq = seq.current;
    setPending((p) =>
      p.map((x) => (x.id === id ? { ...x, afterSeq } : x)),
    );
    await refresh();
  }

  const mode = snap.thread.conversation.mode;
  const mine = role === "admin" ? "human_ts" : "human_creator";
  const canReply = role === "fan" ? mode !== "closed" : mode === mine;
  // A chat waiting in the Trust & Safety queue gets no replies until an admin acts, so the fan is told why instead of
  // typing into silence. Once an admin takes it over (`human_ts`) a person is there to answer, so the composer comes
  // back and the fan can reply to support. The queue covers billing disputes too, so the wording names no team.
  // Realtime stays on, so a takeover or release brings the composer back.
  const tsPaused =
    role === "fan" && mode === "handoff_ts"
      ? "This chat is paused while someone from our team takes a look. You can still read it."
      : undefined;
  const composerNotice = readOnlyNotice ?? tsPaused;

  const lastSaved = snap.thread.messages.at(-1);
  const lastPending = pending.at(-1);
  const lastIsMine = lastPending
    ? true
    : lastSaved
      ? side(lastSaved) === "me"
      : false;
  const preview = lastPending
    ? `You: ${lastPending.text}`
    : lastSaved
      ? `${lastIsMine ? "You: " : ""}${lastSaved.body}`
      : "Say hi";
  // The line under my newest bubble. Only the AI chat has read it for certain; otherwise it is just sent.
  const status =
    role === "fan" && lastIsMine && !typing
      ? mode === "ai"
        ? "Seen"
        : "Sent"
      : null;
  const previewTime = lastPending
    ? "now"
    : lastSaved
      ? shortAge(lastSaved.ageMs)
      : "now";

  const tipPanel =
    role === "fan" && tipOptions && actions.tip && !readOnlyNotice
      ? (close: () => void, closing: boolean) => (
          <TipSheet
            presets={tipOptions.presets}
            minCents={tipOptions.minCents}
            onTip={actions.tip!}
            walletHref={walletHref ?? "/wallet"}
            name={otherName}
            image={otherImage}
            onClose={close}
            closing={closing}
          />
        )
      : undefined;

  return (
    <>
      {sidebar ? (
        <ThreadList
          title={sidebar.title}
          threads={[
            {
              ...sidebar.thread,
              preview,
              time: mounted ? previewTime : "",
              typing,
            },
          ]}
          action={sidebar.action}
          account={sidebar.account}
        />
      ) : null}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader
          name={header.name}
          image={otherImage}
          backHref={header.backHref}
          typing={typing}
          online={role === "fan"}
          status={role === "fan" ? "Active now" : statusLine(snap)}
          actions={header.actions}
        />
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
          }}
          // The browser's own scroll anchoring is off so the prepend correction above is the only one applied.
          className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-2 [overflow-anchor:none] md:px-6 md:pt-2"
        >
          <div className="mx-auto max-w-[760px]">
            {/* A fixed-height slot: the loading row fills it without moving the messages under it. */}
            {olderCursor !== null ? (
              <div ref={sentinel} className="h-[90px] py-2">
                {loadingOlder ? <OlderLoading /> : null}
              </div>
            ) : null}
            {/* The intro marks the start of the chat, so it shows only once the oldest message is loaded. */}
            {olderCursor === null ? <ChatIntro name={otherName} image={otherImage} line={introLine ?? ""} /> : null}
            <MessageList
              rows={rows}
              otherName={otherName}
              otherImage={otherImage}
              typing={typing}
              status={status}
              freshKeys={freshKeys}
              tipSide={role === "fan" ? "me" : "them"}
              renderExtra={(key) => {
                const m = offers.get(key);
                if (!m) return null;
                return (
                  <>
                    {m.offer ? (
                      <LockedCard
                        title={m.offer.title}
                        teaser={m.offer.teaser}
                        price={formatCents(m.offer.priceCents)}
                        state={m.offer.state}
                        action={
                          role === "fan" &&
                          m.offer.state === "locked" &&
                          actions.unlock ? (
                            <Button
                              className="h-10 w-full"
                              disabled={busy}
                              onClick={() =>
                                startTransition(() =>
                                  run(() => actions.unlock!(m.offer!.id)),
                                )
                              }
                            >
                              Unlock
                            </Button>
                          ) : null
                        }
                      />
                    ) : null}
                    {role !== "fan" && m.sender !== "fan" ? (
                      <span
                        tabIndex={0}
                        title={snap.labels[m.id] ?? undefined}
                        className="mt-0.5 mr-1 text-[11px] text-muted"
                      >
                        {m.sender === "ai"
                          ? "AI"
                          : m.sender === "admin"
                            ? "T&S"
                            : m.sender === "system"
                              ? "Platform"
                              : "You"}
                      </span>
                    ) : null}
                  </>
                );
              }}
            />
          </div>
        </div>

        <div className="mx-auto w-full max-w-[760px] px-3 md:px-6">
          {error ? (
            <div
              role="alert"
              className="mb-2 flex items-center gap-2 rounded-full bg-[#FDECEC] py-1 pr-1 pl-3 text-[13px] text-danger"
            >
              <span className="min-w-0 flex-1 truncate">
                {error}
                {error.includes("wallet") && walletHref ? (
                  <>
                    {" "}
                    <Link href={walletHref} className="font-semibold underline">
                      Open wallet
                    </Link>
                  </>
                ) : null}
              </span>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setError(null)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-black/5"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
                  <path
                    d="M3 3l8 8M11 3l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          ) : null}
          {role !== "fan" ? (
            <StaffBar
              role={role}
              snap={snap}
              actions={actions}
              run={(fn) => startTransition(() => run(fn))}
              busy={busy}
              offerItems={offerItems}
            />
          ) : null}
        </div>
        {composerNotice ? (
          <p
            role="status"
            className="px-4 pt-3 pb-7 text-center text-[14px] text-muted-2 md:pb-5"
          >
            {composerNotice}
          </p>
        ) : (
          <Composer
            label={role === "fan" ? `Message ${otherName}` : "Reply"}
            onSend={send}
            onTyping={role === "fan" && actions.typing ? () => void actions.typing!().catch(() => undefined) : undefined}
            typingIntervalMs={TYPING_PING_INTERVAL_MS}
            disabled={!canReply}
            placeholder={canReply ? "Message…" : "Take over to reply"}
            desktopPlaceholder={
              canReply && role === "fan" ? `Message ${otherName}…` : undefined
            }
            tipPanel={tipPanel}
          />
        )}
      </main>
    </>
  );
}

/** A quiet placeholder at the top of the list while an older page loads. */
function OlderLoading() {
  return (
    <div role="status" aria-label="Loading earlier messages" className="flex flex-col gap-1.5">
      <span className="h-[34px] w-[42%] rounded-[20px] bg-surface motion-safe:animate-pulse" />
      <span className="h-[34px] w-[28%] self-end rounded-[20px] bg-surface motion-safe:animate-pulse" />
    </div>
  );
}

function statusLine(snap: Snapshot) {
  const m = snap.thread.conversation.mode;
  return m === "ai"
    ? snap.thread.conversation.aiEnabled
      ? "AI is answering"
      : "AI is off for this chat"
    : m === "human_creator"
      ? "You are replying"
      : m === "human_ts"
        ? "Trust & Safety is replying"
        : m === "closed"
          ? "Closed"
          : "Needs a person";
}

function StaffBar({
  role,
  snap,
  actions,
  run,
  busy,
  offerItems,
}: {
  offerItems?: OfferChoice[];
  role: Role;
  snap: Snapshot;
  actions: ThreadActions;
  run: (fn: () => Promise<ActionResult>) => void;
  busy: boolean;
}) {
  const { mode, aiEnabled } = snap.thread.conversation;
  const h = snap.thread.handoff;
  const human = mode === "human_creator" || mode === "human_ts";
  const reason = h ? (REASON_TEXT[h.reason] ?? h.reason) : null;
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const s = snap.suggested;
  const [offerId, setOfferId] = useState("");
  const canOffer = role === "creator" && mode === "human_creator" && !!actions.sendOffer && !!offerItems?.length;
  const text = draft && s && draft.id === s.id ? draft.text : (s?.body ?? "");

  return (
    <div className="mb-2 flex flex-col gap-2">
      {s && actions.sendSuggested ? (
        <div className="flex flex-col gap-2 rounded-[20px] border border-line bg-surface p-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
            <Badge tone="accent">Suggested reply</Badge>
            <span>Edit it, then send as yourself.</span>
          </div>
          <label htmlFor="suggested" className="sr-only">
            Suggested reply
          </label>
          <textarea
            id="suggested"
            rows={3}
            value={text}
            onChange={(e) => setDraft({ id: s.id, text: e.target.value })}
            className="w-full resize-y rounded-field border border-transparent bg-ground p-3 text-[16px] outline-none focus:border-line-focus md:text-[15px]"
          />
          <div className="flex gap-2">
            <Button
              className="h-10"
              disabled={busy || !text.trim()}
              onClick={() => run(() => actions.sendSuggested!(s.id, text))}
            >
              Send
            </Button>
            <Button
              variant="secondary"
              className="h-10"
              disabled={busy}
              onClick={() => run(() => actions.discardSuggested!(s.id))}
            >
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-[20px] border border-line px-3 py-2 text-[13px] [&>button]:shrink-0">
        {/* A floor on the status width makes the buttons wrap to a second row instead of squeezing the text under them. */}
        <span className="min-w-[12rem] flex-1 text-muted-2">
          {human
            ? role === "admin"
              ? // An admin who takes over a chat with no open handoff holds no claim, so only a claim held by
                // someone else means another member is replying.
                h && !h.claimedByYou && h.status === "claimed"
                ? "Another Trust & Safety member may be replying. Take over to make it yours."
                : "You are replying as Trust & Safety."
              : "You are replying as Juno. The AI is paused."
            : reason
              ? `Needs a person: ${reason}.`
              : mode === "ai"
                ? "The AI is answering."
                : "Waiting."}
        </span>
        {canOffer ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const id = offerId;
              if (!id) return;
              setOfferId("");
              run(() => actions.sendOffer!(id));
            }}
          >
            <label htmlFor="offer-item" className="sr-only">
              Item to offer
            </label>
            <select
              id="offer-item"
              value={offerId}
              onChange={(e) => setOfferId(e.target.value)}
              disabled={busy}
              className="h-9 max-w-[220px] rounded-field border border-line bg-ground px-2 text-[14px]"
            >
              <option value="">Offer an item…</option>
              {offerItems!.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title} ({i.kind}) {formatCents(i.priceCents)}
                </option>
              ))}
            </select>
            <Button type="submit" variant="secondary" className="h-9 px-4 text-[14px]" disabled={busy || !offerId}>
              Send offer
            </Button>
          </form>
        ) : null}
        {role === "creator" && !human && actions.setAi ? (
          <form
            action={() => run(() => actions.setAi!(!aiEnabled))}
            className="flex items-center gap-2"
          >
            <span className="text-muted-2">AI for this chat</span>
            <Switch
              on={aiEnabled}
              name="ai"
              label="AI for this conversation"
              disabled={busy}
            />
          </form>
        ) : null}
        {/* A second admin can take a chat another admin holds. */}
        {actions.takeover && (!human || (role === "admin" && mode === "human_ts" && !h?.claimedByYou)) ? (
          <Button
            className="h-9 px-4 text-[14px]"
            disabled={busy}
            onClick={() => run(actions.takeover!)}
          >
            Take over
          </Button>
        ) : null}
        {role === "creator" &&
        (human || mode === "handoff_creator") &&
        actions.handBack ? (
          <Button
            variant="secondary"
            className="h-9 px-4 text-[14px]"
            disabled={busy}
            onClick={() => run(actions.handBack!)}
          >
            Hand back to AI
          </Button>
        ) : null}
        {/* A chat locked for a minor is never offered back to the AI; Take over and Ban stay. */}
        {role === "admin" &&
        actions.release &&
        !snap.thread.conversation.fanRestricted &&
        (mode === "handoff_ts" || mode === "human_ts") ? (
          <Button
            variant="secondary"
            className="h-9 px-4 text-[14px]"
            disabled={busy}
            onClick={() => run(actions.release!)}
          >
            Release to AI
          </Button>
        ) : null}
        {role === "admin" && actions.ban ? (
          <Button
            variant="secondary"
            className="h-9 px-4 text-[14px] text-danger"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Ban this fan? Their sessions end and they cannot sign in.",
                )
              )
                run(actions.ban!);
            }}
          >
            Ban
          </Button>
        ) : null}
      </div>
    </div>
  );
}
