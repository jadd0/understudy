import type { Events } from "@/platform/ports/events";

export const noopEvents: Events = {
  async emit() {},
};
