import { applyRunnerUp } from "./classify.js";
import { composeReply, loadDraftInputs } from "./compose.js";
import { readBatch } from "./load.js";
import { chooseOffer } from "./offer.js";
import type { PassResult } from "./pass.js";
import { chooseRoute, stopPass } from "./route.js";
import type { TurnState } from "./state.js";

/** One read of the chat: wait for the fan to settle, classify, route, and (when the route speaks) draft and verify. */
export async function runPass(s: TurnState): Promise<PassResult> {
  const read = await readBatch(s);
  if (read.kind === "idle") return { kind: "idle" };
  const { batch } = read;
  const classified = { ...read.classified, jevIn: applyRunnerUp(s, batch, read.classified.jevIn) };
  const routed = chooseRoute(s, batch, classified);
  if (routed.route.name === "hard_stop" || routed.route.name === "hold_creator") return stopPass(s, batch, classified, routed);

  const inputs = await loadDraftInputs(s, batch);
  const picked = await chooseOffer(s, batch, routed.route);
  return composeReply(s, batch, routed, inputs, picked, classified.jevIn.thread);
}
