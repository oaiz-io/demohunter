// The published `demohunter` package is the public CLI and authoring SDK. Keep
// this entrypoint canonical by bundling the internal SDK rather than mirroring
// its declarations by hand.
export * from "../../sdk/src/index.js";
// Review authoring only: `defineReview` and its component helpers are pure
// functions and types, so `*.review.ts` files can import them from the same
// package without pulling Git, Playwright, or the review server into a
// consumer's dependency graph.
export * from "../../review/src/authoring/index.js";
