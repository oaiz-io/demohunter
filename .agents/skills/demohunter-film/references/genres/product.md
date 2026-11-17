# Product film, demo, commercial

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

## Shape

One viewer does one real task in the real product, from need to result. Recorded or lifted UI fills at least 60% of the runtime; scenes frame the product, never replace it. Show the working app, not the marketing page.

The proof is 3–6 verbs, one per beat (*create an invoice, send it, see it paid*), each keeping only what proves its line. The brand lands once, on a built close held 2–3 s, with the URL as the primary element. Most product films are 30–60 s; two minutes for one feature is a walkthrough.

## `PLAN.md` additions

```text
PRODUCT:      name, one-line promise verbatim from its own site, URL
TASK:         the one task the viewer watches, need → result
REAL SCREENS: which captures, which hero elements (refs), what data is on screen
CLAIMS:       ledger: ID | claim as used | verbatim source text | URL | beat
CTA:          the real next step and URL, as the site offers it
```

## Grounded in the product's own material

Read the product's site, docs and changelog first. Copy the promise, feature names, numbers, customer names and the offer verbatim, with URLs, into the CLAIMS ledger (template below). Every name, number, capability and offer in the voice or on screen points to a ledger row. Tone, hooks and connective lines are yours; assertions about the product are not. With no social proof on the site, the proof beat is the product visibly working.

## Hero elements and lifts

Choose 3–5 hero elements: self-contained cards or panels, 200–900 px wide, that change state in the recording and are unique to this product. Lift each at a settled moment with the camera at scale 1, and give each lift a job: expand toward the camera, come alive, then go back or hand off. The workflow is in `../lifts.md`; the moves with code are in `../moves-with-code.md` §1–5 and §14, and `show.js` (`liftShow`, `cursorClick`) already does the pick-up and the click.

## Demo data

The account looks like a real first good week, honestly staged:

- Seed the demo workspace before capture (`beforeRecord`) with an honest demo identity, for example "Demo workspace" and a role name. Never a fixture name like "Test User" in a greeting, a column or a sidebar.
- Make the data real: do the real actions so charts and tables have a visible series. Do not paint numbers in, and do not invent customers or testimonials.
- Mask what must not be seen (`data-dh-mask`; secret-looking fields are masked automatically) and hide cookie banners.

## Typical mistakes

- Slogan cards before any product. Show it by 2 s.
- Setup first, the reason to care last. Lead with the result; compress setup to seconds.
- Full-width recordings at camera scale 1: unreadable on a phone (`../look.md` §6).
- Narration that promises a screen that has not appeared yet (`../words.md` §3).
- Static holds of 4–7 s after an overlay leaves; trim to 1 s.
- An overlay fading out over a dense table, leaving a ghost; slide or scale it out.

## How it starts

1. Write `demos/<name>/PLAN.md`, then the tour (`demohunter` skill). Set `viewport` in `demohunter.config.ts` to the film's size: 1920×1080 for YouTube, 1080×1920 for a vertical film.
2. In the tour, glide (eased scroll over 1200–1800 ms) rather than jump, and park each hero element still for at least 1.5 s so you can lift it.
3. `bun run studio capture demos/<name>/<name>.tour.ts --project .demohunter/replays/<name>`; then cut, frame, lift and build.

## Claims ledger

Keep it in `PLAN.md` under FACTS. A beat that asserts something about the product without a ledger row is a bug.

```md
| ID | Claim as used | Verbatim source text | URL | Used in beat |
|---|---|---|---|---|
| C1 | "<on-screen or voice wording>" | "<exact site text>" | https://… | 1 |
```
