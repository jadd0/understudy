"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

type TurnstileApi = { render: (el: HTMLElement, opts: { sitekey: string }) => string; remove: (id: string) => void };
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * Renders the Turnstile widget explicitly and removes it on unmount. The implicit `cf-turnstile` div rendered only
 * on the first full page load: after a sign-in error redirected back to /signin, the script was already loaded,
 * so no widget appeared and Cloudflare logged "Cannot find Widget" for the one that had gone.
 */
export function Turnstile({ siteKey }: { siteKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(() => typeof window !== "undefined" && Boolean(window.turnstile));

  useEffect(() => {
    const api = window.turnstile;
    if (!ready || !api || !box.current) return;
    const id = api.render(box.current, { sitekey: siteKey });
    return () => api.remove(id);
  }, [ready, siteKey]);

  return (
    <>
      <div ref={box} />
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={() => setReady(true)}
      />
    </>
  );
}
