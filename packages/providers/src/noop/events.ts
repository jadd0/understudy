import type { Events } from "@understudy/engine";

export const noopEvents: Events = {
  async emit() {},
};
