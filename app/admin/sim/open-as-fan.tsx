"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { openAsFanAction } from "./actions";

/** Shows a one-time sign-in link for the run's sim fan; open it in a second browser profile to watch the chat. */
export function OpenAsFan({ runId }: { runId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        className="h-9 px-3 text-[13px]"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await openAsFanAction(runId);
            setUrl(r.ok ? r.url : null);
            setError(r.ok ? null : r.error);
          })
        }
      >
        Open as fan
      </Button>
      {url ? <input readOnly value={url} aria-label="One-time sign-in link" onFocus={(e) => e.currentTarget.select()} className="w-full min-w-0 rounded-field bg-surface p-2 text-[12px]" /> : null}
      {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
