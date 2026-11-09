// The scripted decider and generator on their own, for hosts and demos that need no database helpers (`testing` also
// builds a world in the app's database).

export { FakeDecider } from "./testing/fakes/decider";
export type { FakeDeciderOptions, Scripted } from "./testing/fakes/decider";
export { FakeGenerator } from "./testing/fakes/generator";
export type { FakeGeneratorOptions } from "./testing/fakes/generator";
