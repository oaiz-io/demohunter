# 01 - ToS / policy landscape: recording demos inside Notion, Slack, Gmail

Research date: 2026-09-30. Budget: 9 web searches/fetches (all used).
Scope: can a user point DemoHunter (local Playwright-driven CLI) at their own
logged-in account in Notion, Slack, or Gmail and record a narrated demo?

Not legal advice. Quotes are short and verbatim from the fetched pages. Anything
not fetched and read directly is marked **UNVERIFIED**.

## Framing: two distinctions that matter

1. **Account type**
   - *Personal/consumer account*: the user is the only party whose consent
     matters (besides the vendor's terms).
   - *Org/admin-managed account* (Google Workspace, Slack workspace, Notion
     team/Enterprise workspace): the org is the vendor's customer. The admin can
     set extra rules, block integrations, enforce SSO/2FA/session policies, and
     suspend the account. The user's own consent is not enough.
2. **Who is doing the automating**
   - *User-driven local automation*: the user runs DemoHunter on their machine,
     against their own session, a handful of times, at human-ish pace, to record
     their own content. Low volume, not scraping, no credential custody by us.
   - *Productized feature*: DemoHunter (or a future Cloud) ships "log in to
     Gmail/Slack/Notion" as a feature, stores sessions, or runs it on our
     servers. This raises credential-custody, bot-detection, and "facilitating
     breach" exposure, and would conflict with the AGENTS.md rule that
     DemoHunter does not store credentials.

## 1. Google (Gmail / Google Account)

### (a) Automated access - Google Terms of Service
Source: https://policies.google.com/terms (fetched version shows
"Effective July 30, 2026"; the fetch returned the Finland locale, wording
expected to match other locales but that is **UNVERIFIED**).

- Prohibited abuse includes: "using automated means to access content from any
  of our services in violation of the machine-readable instructions on our web
  pages (for example, robots.txt files that disallow crawling, training, or
  other activities)".
- Also prohibited: "spamming, hacking, or bypassing our systems" and
  "accessing or using our services or content in fraudulent or deceptive ways".
- Suspension grounds include "hacking, phishing, harassing, spamming, misleading
  others, or scraping content."

Reading: the automated-means clause is scoped to violating machine-readable
instructions (robots.txt), i.e. it targets crawling/scraping, not a user
clicking through their own inbox with a scripted browser. It is not a blanket
"no automation" ban. However "bypassing our systems" is the risk: any stealth
plugin / fingerprint spoofing to get past the sign-in block below would be
hard to defend as anything other than bypassing Google's systems.

### (b)/(c) Sign-in from automated browsers is blocked technically
Source: https://support.google.com/accounts/answer/7675428
("Couldn't sign you in" / "This browser or app may not be secure").

Google may block sign-in from browsers that:
- "Are being controlled through software automation rather than a human"
- "Are embedded in a different application"
- "Don't support JavaScript or have JavaScript turned off"
- "Have unsecure or unsupported extensions added"

For embedded frameworks (CEF) developers are told to "migrate to a more secure
alternative" (browser-based OAuth / PWA).

Implication: a Playwright-launched browser performing the Google login flow is
explicitly in the blocked category. The policy-compatible path is: the user
signs in manually in a normal browser profile (human does the login + 2FA),
and DemoHunter reuses that already-authenticated state (e.g. Playwright
`storageState` or a persistent user-data dir the user created). Whether Google
later invalidates or challenges sessions reused under automation is a
technical question for another note - **UNVERIFIED** here.

### (b) Passwords / 2FA / Less Secure Apps
- Google ToS: users should take "reasonable steps to keep your Google Account
  secure".
- Less Secure Apps (password-only sign-in for third-party apps) was retired in
  favor of OAuth. The Workspace admin page support.google.com/a/answer/14114704
  now 301-redirects to
  https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth
  (title slug: "transition from less secure apps to OAuth"). I did not fetch the
  body (budget), so exact dates/wording are **UNVERIFIED**. From memory
  (UNVERIFIED): LSA was turned off for Workspace accounts across 2024-2025 and
  OAuth is required. Either way, "give DemoHunter your Google password" is not a
  supported path, and it should never be one.

### Workspace-managed accounts
- Google ToS: "your organization's administrator may assign a Google Account to
  you. That administrator might require you to follow additional rules and may
  be able to access or disable your Google Account."
- Admin session controls / context-aware access / device policies could block or
  flag an automated browser. Specific admin-console docs were not fetched -
  **UNVERIFIED**.

### Gmail Program Policies
Not fetched (budget) - **UNVERIFIED**. Expected to focus on spam/abuse content,
not UI automation.

## 2. Slack

### Structure
- Slack user terms: https://slack.com/terms-of-service/user (Effective
  February 17, 2023 per the fetched page).
- Slack AUP page https://slack.com/acceptable-use-policy ("Last Updated: July 8,
  2025") now just points to the Salesforce "Acceptable Use and External-Facing
  Services Policy" PDF:
  https://www.salesforce.com/en-us/wp-content/uploads/sites/4/documents/legal/Agreements/policies/ExternalFacing_Services_Policy.pdf
  (PDF also says "Last Updated ... July 08, 2025"). Text extracted locally from
  the downloaded PDF.

### Org/admin control is central (every Slack account is org-managed)
- AUP: "Slack is not available for consumer purposes, as Slack is intended for
  use by businesses and organizations."
- User terms: "Customer may provision or deprovision access to the Services,
  enable or disable third party integrations, manage permissions, retention and
  export settings".
- User terms: "all Authorized Users must comply with our Acceptable Use Policy
  and any applicable policies established by Customer".
- User terms: access can be "terminated by Customer or us."

So for Slack there is effectively no "personal account" case: the workspace
owner (Customer) is the party whose rules govern. A user who owns their own
free workspace (e.g. a demo workspace) is both Customer and user - the cleanest
case.

### (a) Automated access
The Salesforce AUP, as extracted, contains **no clause banning a user from
driving the Slack web client with browser automation**. The only scraping clause
concerns using the services to scrape *third-party* sites:
- "Access a third-party web property for the purposes of web scraping, web
  crawling, web monitoring, or other similar activity through a web client that
  does not take commercially reasonable efforts to identify itself via a unique
  User Agent string ... and obey the robots exclusion standard".
Other relevant items:
- "Intentionally or unintentionally interfere with the availability of the
  service for other users, including, but not limited to, engaging in usage
  practices prohibited by the Documentation" (i.e. rate/usage rules in API docs).
- "Perform significant load or security testing without first obtaining
  Salesforce's written consent".
- Anti-deepfake: no "highly deceptive manipulated or synthetic digital media
  that is fabricated or false but presented as authentic" - relevant only if a
  demo misrepresents real people/messages; a labeled product demo is not that.
- "Mining data or harvesting any web property ... to find email addresses or
  other user account information" - not what a demo recorder does.

Slack's Customer Terms / API Terms may contain a "no access except via
published interfaces" clause - not fetched, **UNVERIFIED**.

### (b) Credentials
The fetched user terms page did not surface an explicit password-confidentiality
or credential-sharing clause (fetch summary said none present in isolated form)
- treat as **UNVERIFIED** rather than "absent". SSO/2FA are workspace-admin
controlled.

### Official alternative
Slack Web API / Slack apps (admin-installable) exist for seeding demo content
(posting messages, creating channels) - admin may "enable or disable third party
integrations".

## 3. Notion

### Fetch result
Notion's ToS URL https://www.notion.com/terms 307-redirects to
https://app.notion.com/terms, which is a JS-rendered page; the fetch returned
only the word "Notion". A site-restricted search did not return the ToS text.
**All Notion ToS/AUP wording is UNVERIFIED in this pass.**

Relevant pointers found:
- Notion "Our content and use policy" blog:
  https://www.notion.com/blog/our-content-and-use-policy (search snippet:
  Notion uses "a combination of automated and manual solutions to scan for,
  identify, and remove publicly shared pages that violate their terms of
  service") - content moderation, not automation of the client.
- Enterprise security provisions (admin controls, SAML SSO, etc.):
  https://www.notion.com/help/guides/notion-enterprise-security-provisions
  (not fetched; UNVERIFIED specifics).

From memory, needs verification (UNVERIFIED): Notion's Terms of Service include
a restriction on accessing the service by automated means / scraping other than
via the public API, and on sharing login credentials; workspace owners on
team/Enterprise plans control members, integrations, and SSO.

### Official alternative
Notion has a public REST API and integrations (internal integration tokens
scoped to pages the user shares with them). Useful for seeding demo content in a
dedicated demo workspace; UI recording still requires the web client.

## Friendliness ranking (for "user records own demo in own account")

1. **Notion - most friendly in practice (policy text UNVERIFIED).** A user can
   create a free personal workspace dedicated to demos, is the owner, has an
   official API for seeding content, and there is no known technical block on
   automated browsers at login. Risk hinges on the exact "automated means"
   wording in the ToS, which must be verified before shipping any doc/example.
2. **Slack - friendly if the user owns the workspace.** The Salesforce AUP
   (verified) has no clause against automating one's own web client; the
   constraints are org-level (Customer/admin sets rules, integrations,
   SSO/2FA) and "don't degrade service / no load testing". Every Slack account
   is org-managed, so in someone else's workspace the user needs admin buy-in.
   Recommending a dedicated demo workspace makes this clean.
3. **Google/Gmail - least friendly.** Wording in the ToS is narrower than a
   blanket ban (robots.txt-scoped automated-means clause), but Google
   *technically* blocks sign-in from "software automation", prohibits
   "bypassing our systems", has retired password-only (LSA) access, and
   Workspace admins can impose further controls. Only viable pattern: human
   signs in manually, DemoHunter reuses the session, no stealth/anti-detection.

## Implications for DemoHunter

- OK (low risk) to document: "record in your own account/workspace, sign in
  yourself, DemoHunter reuses a saved browser session locally." Keep it
  user-driven and local.
- Do not: automate login forms for Google, ship stealth/anti-bot-detection
  plugins, store/transmit credentials or session cookies (conflicts with
  AGENTS.md credential boundary), or run third-party SaaS sessions in any hosted
  Cloud product without per-provider review.
- Recommend dedicated demo accounts/workspaces with synthetic data (avoids
  admin-policy issues, PII in recordings, and the deepfake/misrepresentation
  angle).
- Org-managed accounts: tell users to check with their admin; policy is set by
  the org, not by us.

## Open verification items
- Notion ToS exact automated-access and credential clauses (render
  app.notion.com/terms in a real browser).
- Google LSA-to-OAuth page body and dates.
- Slack Customer Terms / API Terms "published interfaces" clause.
- Gmail Program Policies.
- Google Workspace admin session-control / context-aware-access docs.
