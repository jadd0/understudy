// The scripted decider and generator on their own, for hosts and demos that need no database helpers (`testing` also
// builds a world in the app's database).

export { FakeDecider } from "./fake/decider";
export type { FakeDeciderOptions, Scripted } from "./fake/decider";
export { FakeGenerator } from "./fake/generator";
export type { FakeGeneratorOptions } from "./fake/generator";
