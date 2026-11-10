import type { Events } from "@jadd0/understudy-engine";

export const noopEvents: Events = {
  async emit() {},
};
