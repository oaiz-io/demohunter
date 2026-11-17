# Explainer and tutorial

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

## Shape

One idea the viewer understands by the end. The spine is one worked example taken from question to answer, not a tour of facts. Usually 30–90 s.

- **Start in the viewer's world.** A person, place or situation they know, and a question they would ask about it. The diagram enters inside that situation as the thing that answers the question, and the film returns to the situation at the end. A film that opens on the diagram alone is a diagram, not an explainer.
- **Concrete before abstract.** Show the case, then name the rule.
- **Misconception first** when one exists: show the wrong idea working, then let the evidence break it.
- **One diagram that grows.** Start from the simplest true picture and add one part per beat, each appearing when the voice names it. Never drop a finished diagram on screen.
- **End on the one idea in one line.** No brand close unless asked.

Shapes of information each have their own picture: a number that lands, a myth struck through, before and after, many things converging into groups, one chosen out of many, steps in order, a real screenshot with one detail circled. Pick the shape, then the picture, so similar lines get different pictures.

## `PLAN.md` additions

```text
MISCONCEPTION:   the wrong idea the viewer arrives with, if any
WORKED EXAMPLE:  the one input that travels through every step
DIAGRAM STATES:  the build order, one part per beat, each with the word that reveals it
CHECK THE LOGIC: each step, and how you verified it (source, calculation)
```

## In DemoHunter

`bun run studio new <dir> --title "<title>" --size 1920x1080`. Each beat is a scene clip; a growing diagram is one SVG scene (or a few) in which parts appear by `animate` on `opacity`, `clip-path` or `stroke-dashoffset`, timed to the narration (`../words.md` §3). Labels sit on the part they name, with a leader line, and appear with it; no legends. Keep about 19 spoken words per scene; without a voice, lines of up to 10 words held `readTime`.

When the explanation is about a real web UI (a tutorial), capture it instead, and frame it hard (`../look.md` §6).

## Typical mistakes

- Bullet slides, icons in circles, three cards in a row.
- The whole diagram at once, then a voice walking through it.
- A narrator reading the on-screen text word for word.
- A beautiful, wrong diagram. Check the science or the logic of each step before you animate it; one data module drives every number so they agree.
- Three abstract scenes before anything the viewer recognises.

## Worked example

"How does a password manager know your password without storing it?" Opens on a login screen with a cursor in the password field (the viewer's world). Misconception: "it keeps a list of my passwords in plain text". The worked example is one password, "correct horse", taken through key derivation into a vault that the server cannot open. The diagram grows one box per beat: device → key → vault → server, with a padlock that stays shut on the server side. Close: "Only your device can open your vault."
