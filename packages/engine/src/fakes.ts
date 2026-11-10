// The scripted decider and generator on their own, for hosts and demos that need no database helpers (`testing` also
// builds a world in the app's database).

export { FakeDecider } from "./testing/fakes/decider.js";
export type { FakeDeciderOptions, Scripted } from "./testing/fakes/decider.js";
export { FakeGenerator } from "./testing/fakes/generator.js";
export type { FakeGeneratorOptions } from "./testing/fakes/generator.js";
