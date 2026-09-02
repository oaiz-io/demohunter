# Project scope

DemoHunter turns Playwright-style TypeScript tours into narrated product-demo assets. It is an open-source CLI and SDK from OAIZ Labs.

The open-source product must work locally without an OAIZ service. It writes portable, versioned output under `.demohunter/`. Text-to-speech providers are optional and read credentials only from environment variables. A complete narration cache must support offline regeneration.

Hosted products can use DemoHunter output in the future, but they must remain optional additions to the open-source workflow.
