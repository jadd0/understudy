import type { Route } from "../types.js";

export type TurnResult =
  | { status: "busy" | "idle" }
  | { status: "committed"; turnId: string; route: Route["name"]; outcome: string; creatorId: string }
  | { status: "superseded"; turnId: string }
  | { status: "error"; turnId: string };

/** Class and code only: an error's message can carry fan text. */
export function describeError(e: unknown): string {
  const err = e as { name?: string; code?: string; reason?: string; status?: number };
  return [err?.name ?? "Error", err?.code ?? err?.reason ?? (err?.status ? `http_${err.status}` : "")].filter(Boolean).join(" ");
}
