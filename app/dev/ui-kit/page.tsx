import { notFound } from "next/navigation";
import { groupMessages } from "@/lib/ui/group-messages";
import { Button, IconButton } from "@/components/ui/button";
import { IconCompose, IconWallet } from "@/components/ui/icons";
import { ChatHeader, ChatIntro } from "@/components/ui/chat/chat-header";
import { MessageList } from "@/components/ui/chat/message-list";
import { ThreadList } from "@/components/ui/chat/thread-list";
import { LockedCard } from "@/components/ui/chat/locked-card";
import { ComposerPreview } from "./composer-preview";

/** Development-only gallery of the UI kit, laid out as the chat design. 404 in production. */
export default function UiKitPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const now = new Date("2026-11-03T14:45:00");
  const at = (h: number, m: number) => new Date(2026, 10, 3, h, m);
  const rows = groupMessages(
    [
      { id: "1", side: "them", text: "heyyy 🙈", at: at(14, 2) },
      { id: "2", side: "them", text: "u been good?", at: at(14, 2) },
      { id: "3", side: "me", text: "better now that you replied", at: at(14, 3) },
      { id: "4", side: "me", text: "what are you up to tonight", at: at(14, 3) },
      { id: "5", side: "them", text: "having lots of tiramisu rn 😏", at: at(14, 4) },
      { id: "6", side: "me", text: "send pics or it didn't happen", at: at(14, 41) },
      { id: "7", side: "them", text: "hmm maybe i have smth for u 🤭", at: at(14, 42) },
      { id: "8", side: "system", text: "You tipped $10.00", at: at(14, 43), tip: "$10.00" },
    ],
    now,
  );
  return (
    <div className="flex h-screen min-h-[600px]">
      <ThreadList
        title="Messages"
        account={{ name: "Sam Carter", roleLabel: "Fan" }}
        action={
          <IconButton label="New message">
            <IconCompose />
          </IconButton>
        }
        tabs={[
          { label: "Primary", href: "#", on: true },
          { label: "Handoffs", href: "#" },
          { label: "Requests", href: "#" },
        ]}
        threads={[
          { id: "a", name: "Juno", preview: "hmm maybe i have smth for u 🤭", time: "2m", href: "#", active: true, online: true },
          { id: "b", name: "Marco D", preview: "You: ok deal", time: "18m", href: "#", unread: true, badge: "Handoff" },
          { id: "c", name: "Leo Hart", preview: "lol", time: "1h", href: "#", badge: "AI" },
        ]}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader
          name="Juno"
          online
          typing
          backHref="#"
          actions={
            <>
              <IconButton label="Wallet">
                <IconWallet />
              </IconButton>
            </>
          }
        />
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-2 md:px-6 md:pt-2">
          <div className="mx-auto max-w-[760px]">
            <ChatIntro name="Juno" line="junovale · 🌊 brighton" />
            <MessageList
              rows={rows}
              otherName="Juno"
              typing
              renderExtra={(key) =>
                key === "7" ? (
                  <LockedCard
                    title="Sea glass set"
                    teaser="the one i didn't post 🤫"
                    price="$14.99"
                    action={<Button className="h-10 w-full">Unlock</Button>}
                  />
                ) : null
              }
            />
          </div>
        </div>
        <ComposerPreview />
      </main>
    </div>
  );
}
