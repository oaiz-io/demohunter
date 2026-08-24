import {
  changeSet,
  codeEvidence,
  compatibilityNote,
  componentDiagram,
  coverageGroup,
  defineReview,
  diffEvidence,
  reviewerQuestion,
  risk,
  securityNote,
  sequenceDiagram,
  verificationCommand,
} from "demohunter";

export default defineReview({
  id: "checkout-retry-review",
  title: "Retry failed checkout captures",
  subtitle: "Adds a bounded retry around the payment capture call",
  pullRequest: { number: 412, branch: "feat/checkout-retry" },
  problem: {
    summary:
      "Transient gateway timeouts dropped roughly one capture in two hundred, and the order was left paid but unconfirmed.",
    detail:
      "The capture call had no retry, so a single upstream timeout stranded the order in a state only support could clear.",
    inScope: ["The capture call and its retry policy", "The metric that proves the retry works"],
    outOfScope: ["Refunds", "The gateway client's connection pooling"],
  },
  goals: ["Retry transient capture failures without ever double-charging"],
  nonGoals: ["A general-purpose retry framework"],
  decisions: [
    {
      id: "idempotency-key",
      title: "Reuse the order id as the idempotency key",
      rationale:
        "The gateway deduplicates on the key, so retrying with the same key is safe where retrying with a fresh one is not.",
      alternatives: ["A random key per attempt", "A queue with at-least-once delivery"],
    },
  ],
  architecture: [
    componentDiagram({
      id: "capture-path",
      title: "Capture path",
      caption: "The retry lives in the checkout service, not in the gateway client.",
      nodes: [
        { id: "checkout", label: "Checkout service", kind: "service", column: 0, row: 0 },
        { id: "retry", label: "Capture retry", kind: "module", detail: "3 attempts, backoff", column: 1, row: 0, changed: true },
        { id: "gateway", label: "Payment gateway", kind: "external", column: 2, row: 0 },
        { id: "orders", label: "Orders table", kind: "store", column: 1, row: 1 },
      ],
      edges: [
        { from: "checkout", to: "retry", label: "capture(order)", changed: true },
        { from: "retry", to: "gateway", label: "POST /captures", changed: true },
        { from: "retry", to: "orders", label: "record attempt", style: "dashed", changed: true },
      ],
    }),
    sequenceDiagram({
      id: "retry-sequence",
      title: "Retry sequence",
      caption: "Only timeouts retry; a declined card fails immediately.",
      participants: [
        { id: "checkout", label: "Checkout" },
        { id: "retry", label: "Capture retry" },
        { id: "gateway", label: "Gateway" },
      ],
      messages: [
        { from: "checkout", to: "retry", label: "capture(order)" },
        { from: "retry", to: "gateway", label: "attempt 1" },
        { from: "gateway", to: "retry", label: "timeout", kind: "return" },
        { from: "retry", to: "retry", label: "back off 200ms", kind: "note" },
        { from: "retry", to: "gateway", label: "attempt 2, same key" },
        { from: "gateway", to: "retry", label: "captured", kind: "return" },
        { from: "retry", to: "checkout", label: "ok", kind: "return" },
      ],
    }),
  ],
  reviewOrder: [
    { chapterId: "retry-policy", why: "It defines what counts as retryable; everything else follows." },
    { chapterId: "capture-call-site", why: "Shows how the policy is applied without changing the happy path." },
  ],
  chapters: [
    changeSet({
      id: "retry-policy",
      title: "Retry policy",
      intent:
        "Introduces a bounded retry that only fires on transport timeouts, reusing the order id as the idempotency key.",
      narration:
        "The retry policy is deliberately narrow. It retries transport timeouts up to three times with backoff, and it reuses the order identifier as the idempotency key so a repeated attempt can never double charge.",
      files: ["src/checkout/capture-retry.ts"],
      evidence: [
        diffEvidence({
          id: "retry-policy-diff",
          path: "src/checkout/capture-retry.ts",
          title: "Retry classification",
          note: "Confirm that a declined card is not classified as retryable.",
        }),
        codeEvidence({
          id: "retry-policy-constants",
          path: "src/checkout/capture-retry.ts",
          startLine: 1,
          endLine: 12,
          title: "Bounds",
          note: "Attempt count and backoff are constants, so the worst-case latency is bounded.",
        }),
      ],
      reviewerChecks: [
        { id: "retry-only-timeouts", check: "Only transport timeouts are retried." },
        { id: "retry-key-stable", check: "The idempotency key is identical across attempts." },
      ],
    }),
    changeSet({
      id: "capture-call-site",
      title: "Capture call site",
      intent: "Routes the existing capture call through the new policy without changing the success path.",
      narration:
        "At the call site the change is small. The capture call now goes through the retry policy, and the successful path is byte for byte what it was before.",
      files: ["src/checkout/place-order.ts"],
      evidence: [
        diffEvidence({
          id: "call-site-diff",
          path: "src/checkout/place-order.ts",
          title: "Call site",
          note: "The success branch is unchanged; only the failure path is new.",
          range: { startLine: 88, endLine: 120 },
        }),
      ],
      reviewerChecks: [
        { id: "success-path-unchanged", check: "The success path behaves exactly as before." },
      ],
    }),
  ],
  verification: [
    verificationCommand({
      id: "unit",
      label: "Checkout unit tests",
      command: ["npm", "test", "--", "src/checkout"],
      rationale: "Covers the retry classification table and the idempotency key.",
    }),
    verificationCommand({
      id: "typecheck",
      label: "Typecheck",
      command: ["npx", "tsc", "--noEmit"],
      rationale: "The retry wrapper changes the capture call's return type.",
    }),
  ],
  risks: [
    risk({
      id: "latency",
      title: "Worst-case checkout latency grows",
      severity: "medium",
      detail: "Three attempts with backoff add up to roughly 600ms before the request finally fails.",
      mitigation: "The attempt count and backoff are constants, and the request timeout is unchanged.",
    }),
  ],
  compatibility: [
    compatibilityNote({
      id: "capture-errors",
      area: "Capture error shape",
      impact: "behavioral",
      detail: "A timeout now surfaces after the final attempt rather than on the first failure.",
      migration: "Callers that already handle the timeout error need no change.",
    }),
  ],
  security: [
    securityNote({
      id: "idempotency",
      title: "Retries cannot double-charge",
      detail: "Every attempt reuses the order id as the gateway idempotency key, so the gateway deduplicates them.",
      control: "src/checkout/capture-retry.ts",
    }),
  ],
  reviewerQuestions: [
    reviewerQuestion({
      id: "attempt-count",
      question: "Is three attempts the right bound, or should it come from config?",
      context: "Three keeps the worst case under a second; config would make the bound harder to reason about.",
    }),
  ],
  coverage: {
    groups: [
      coverageGroup({
        id: "tests",
        title: "Tests",
        rationale: "Test files are reviewed together with the behaviour they cover.",
        patterns: ["**/*.test.ts", "tests/**"],
      }),
      coverageGroup({
        id: "docs",
        title: "Docs",
        rationale: "Documentation follows the behaviour described above.",
        patterns: ["**/*.md", "docs/**"],
      }),
    ],
  },
  narration: {
    closing: "If you only check one thing, check that a declined card still fails on the first attempt.",
  },
});
