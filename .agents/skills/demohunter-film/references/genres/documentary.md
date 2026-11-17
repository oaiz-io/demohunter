# Documentary and video essay

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

## Shape

An argument carried by evidence: the voice is the clock and the pictures prove what it says. The spine is one person, place or object whose story carries the thesis.

- **Thesis**: one sentence a viewer could disagree with. "Cities got hotter" is a topic; "Paving, not climate, made this street 4 °C hotter" is a thesis.
- **Argument chain**: each step linked by "but" or "therefore", and resting on evidence you can show.
- **Turn**: where the obvious explanation fails, about a third in.
- **Cut** for feeling first, then story, then rhythm.
- **Change the kind of picture at least every 30–60 s** (a map, a document, a number, a chapter card); a practitioner default, not a measured law.

## `PLAN.md` additions

```text
THESIS:         one disputable sentence
ARGUMENT CHAIN: step → "but"/"therefore" → step … each with its evidence ID
EVIDENCE:       ID | what it shows | source (URL, archive, person) | licence | file in scenes/
B-ROLL MAP:     narration phrase → the picture on screen → evidence ID or "made in HTML/SVG"
VOICE IS THE CLOCK: segment durations after narrate, and the cut points they set
CHAPTERS:       title and start time, if the film runs over about 3 min
```

## Media: what you have and what you make

DemoHunter has no stock-media search. Pictures come from two places:

1. **Files the person gives you**: photographs, scans, footage. Record each in EVIDENCE with source and licence; if the licence is unknown, ask or leave it out.
2. **Pictures you make in HTML and SVG**: drawn maps, timelines, quotes and documents set as type, diagrams, charts with a source line.

When the B-ROLL MAP needs a picture you lack, put the phrase over something you can honestly show (the quote, the date, the place on a drawn map) and list the gap in the delivery note. Never draw a fake photograph, document or screenshot.

## In DemoHunter

`bun run studio new <dir> --title "<title>" --size 1920x1080`. Write the narration first; after `narrate`, each segment's `audio.durationMs` sets its scene's length.

- **Stills**: `kenBurns` on a wrapper, moving toward what the voice names, 5–15% scale change per still, alternating direction from still to still (`../motion.md` §6).
- **Footage**: a `<video>` in a scene plays from its first frame at the scene's start, so trim the file to the shot first; the engine seeks it as picture. Carry sound with `<audio data-start>` or `audio.music`.
- **J and L cuts** keep a long film from feeling like slides (`../motion.md` §8).
- **Chapters**: a chapter card scene (one or two words, 400–1200 ms) at each chapter start, and the chapter times in the delivery note for YouTube. A scene clip runs at most 120 s; split long scenes.

## Typical mistakes

- A topic instead of a thesis, so the film is a list.
- Pictures that decorate the voice instead of proving it.
- A source line missing for a number, a quote or a photograph.
- Desaturation, grain and vignettes standing in for evidence.
- The same Ken Burns direction on every still.

## Worked example

Thesis: "The flood came from the new car park, not the rain." Spine: one street. Chain: the rain was ordinary (rainfall record, E1) **but** the street flooded for the first time (residents' photographs, E2) **therefore** something changed upstream (planning map, E3). B-roll: "ordinary rain" → a chart from E1 with its source line; "the first time" → E2, `kenBurns` toward the waterline; "upstream" → E3 redrawn in SVG.
