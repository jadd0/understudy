"use client";

import { TipSheet } from "@/components/chat/tip-sheet";
import { Composer } from "@/components/ui/chat/composer";

export function ComposerPreview() {
  return (
    <Composer
      label="Message Juno"
      onSend={() => {}}
      desktopPlaceholder="Message Juno…"
      tipPanel={(close, closing) => (
        <TipSheet
          presets={[200, 500, 1000]}
          minCents={200}
          onTip={async () => ({ ok: true })}
          walletHref="#"
          name="Juno"
          onClose={close}
          closing={closing}
        />
      )}
    />
  );
}
