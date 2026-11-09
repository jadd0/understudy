"use client";

import { useEffect } from "react";

/** Navigates the whole window (not a client-side route change), with a link as the fallback. */
export function GoTo({ href }: { href: string }) {
  useEffect(() => {
    window.location.replace(href);
  }, [href]);
  return (
    <a href={href} className="text-[15px] font-semibold underline">
      Continue
    </a>
  );
}
