# Story

Portions adapted from Hyperframes (Apache-2.0, HeyGen) and brag (MIT).

Most weak films are good motion around no story: a list of features, a row of cards, a logo, a URL. Find the story in words first; a beat changed in `PLAN.md` costs a minute, and after the build it costs an hour. When the person gave a script, a storyboard or a reference film, follow theirs and use this file for its gaps.

Contents: 1 The one thing · 2 The spine · 3 Three storylines · 4 Links between beats · 5 The hook · 6 Beats and the payoff · 7 Copy · 8 The `PLAN.md` template · 9 Worked example

## 1. The one thing

Write what the viewer takes away, in their words. "I can send an invoice in a minute and see when it is paid" is a take-away; "Billing, reimagined" is a slogan. If it needs two sentences, it is two films; pick one.

Keep facts apart from choices. Facts (what it does, numbers, names, dates) come from a source and go in FACTS. Angle, tone and look are yours. Never derive a claim the source did not make: "40 minutes to 2" is not "20× faster".

## 2. The spine

One concrete case runs from the first frame to the last, and everything happens to it.

| Film | Spine |
| --- | --- |
| Product | one person doing one real task, need to result; one real piece of data travels through it |
| Explainer | one worked example taken through every step |
| Documentary or essay | one person, place or object whose story carries the argument |
| Data story | one dataset, and the one number in it that matters |
| Short | one change, shown once |

Without a spine a film becomes a tour: this, and this, and this.

## 3. Three storylines, then one

Write three different films, not three titles for one. Each pairs a **device** (what the story is) with a **form** (how the camera and cuts carry it). Sketch five pairings, drop those the subject cannot carry, keep the three that differ most, and make one the bold choice you would not have picked first.

| Device | What the viewer sees |
| --- | --- |
| A moment in someone's day | a person, a time, the message that creates the need |
| The result first | the finished output, then how it came to be |
| Before and after | the old way failing on screen, then the new way |
| A number lands | one real number, earned by the scene before it, made physical |
| The object is the explanation | a thing whose working is the idea; the camera tours it |
| A misconception turned over | the common belief, shown, then broken by evidence |

| Form | What the viewer sees |
| --- | --- |
| One continuous take | no cuts; the camera pushes, follows and pulls |
| Object-to-object chain | every shot ends on the thing that opens the next |
| One frame that rebuilds | one composition rearranges itself and never leaves |
| Match cuts | one shape holds while everything around it changes |
| Cut on the beat | hard cuts on the music, type and colour changing on the bar |

For each storyline write: device × form; the first two seconds, exactly; the beats in one line; the look in one line; the sound in one line.

Pick the one a stranger would follow and remember, ahead of the most striking picture, and write why in one clause. If the person wants a say, show the three and let them pick; otherwise build your pick and name the other two in the delivery note.

## 4. Links between beats

Between two beats the word is "but" or "therefore", never "and then". "The invoice is sent, **but** was it paid? **Therefore** the payments page" is a story; "here is the invoice page, and here is the payments page" is a tour. Write the link for every beat. A beat you cannot link is in the wrong place or not in the film.

Each beat earns one belief and causes the next: a click opens it, a question asks for it, a number demands an explanation.

## 5. The hook

Frame 0 is the thumbnail and the autoplay frame. It is never empty, a bare gradient, or a logo alone. It is a finished composition that already says what the film is about: the subject with one line of type, or the result itself. Motion may start at once; legibility does not wait for it.

The subject is on screen within two seconds: the product, the situation the question lives in, the essay's person or place. Two slogan cards before any picture lose the viewer.

Strong openings: the result already working on something recognisable; a real moment that creates the need; a question with its input inside it; the problem failing on screen. Typing into an empty prompt box as the opener is a tell of a generated film; a few seconds in, it is fine.

## 6. Beats and the payoff

| Job | Share | What it does |
| --- | --- | --- |
| Hook | 5–10% | the world and the need, or the result already working |
| Turn | 10–15% | the old way failing, the question sharpened |
| Proof | 40–50% | the case worked through, one verb or step per beat |
| Payoff | 15–20% | the answer, at normal speed, 60–80% of the way in |
| Close | 8–10% | the one thing in one line; the name and next step, held 2–3 s |

The process runs fast; the payoff plays at normal speed after 0.3–0.75 s of stillness, once.

Length follows the story: most product films and explainers run 30–75 s, a short 15–45 s. A requested length is a range, never padded. One idea per beat of 4–10 s, something new every 2–4 s. More than about 3 s with nothing changing and nothing to read is dead; cut it.

## 7. Copy

- Titles: at most 6 words a line (10 in an explainer), one line at a time, no trailing periods.
- A line holds `readTime(text)` once settled (500 ms + 300 per word); the last line at least 2 s. Too many words: cut words, never shrink type or hold.
- Real numbers only, rounded the same way everywhere.
- Never open on "Introducing", "Meet" or a logo. Never "unlock", "seamless", "supercharge", "game-changer", "revolutionize", "effortless", "streamline", or "in seconds" unless measured.
- Read the lines alone: a stranger gets the point. Look at the pictures alone: they tell the same story.

## 8. The `PLAN.md` template

Fill every line, and add your genre's lines from `genres/`.

```text
FILM:      the one thing the viewer must take away, in their words (not a slogan)
FOR:       who watches, where (feed, YouTube, a talk, a site), sound on or off
SHAPE:     length as a range · aspect · fps · narrated / music only / silent
SPINE:     the one concrete case that runs from first frame to last
           (a user and a task; a worked example; a person or place; one dataset)
QUESTION:  what the opening makes the viewer want to know
ANSWER:    the payoff, and when it lands (usually 60–80% in)
STORYLINES: three one-liners (device × form), the pick, and why in one clause
BEATS:     # | in–out s | job (hook/turn/proof/payoff/close) | what happens
           | link to previous beat ("but…" / "therefore…") | what is read, with window
           | voice line | sound | handoff into the next beat
LOOK:      ground, ink, one accent and where it may appear (hex);
           display and body face, px, tracking; the medium and its rules
MOTION:    eases by role (enter, move, exit, camera); hold rule; 3–5 transition kinds
BANNED:    the shared defaults + anything this film must not become
FACTS:     every claim → its source; illustrative numbers marked; media licences
LOOK AT:   the times to snapshot (each beat, each cut, the payoff, frame 0)
```

## 9. Worked example

Request: a 45 s explainer on why bread stales faster in the fridge.

- FILM: "The fridge stales bread; the counter or the freezer keep it." SPINE: one sliced loaf over three days.
- QUESTION: "Why is the fridge loaf worse?" ANSWER: the starch recrystallises fastest just above freezing, at 30 s.
- STORYLINES: A, the object is the explanation × one continuous take: the camera dives into one slice as its starch locks into crystals while a thermometer drops. B, before and after × split screen to one: two loaves, three days, one goes stale. C, a misconception turned over × match cuts: "the fridge keeps food fresh" stamped on milk, then on bread, then struck through. Pick A: the viewer sees the cause, not only the result.
- BEATS: hook, the loaf on a fridge shelf, "Why is this loaf worse?" · turn, **but** the counter loaf is still soft · proof, **therefore** the camera dives into the crumb · proof, the cold locks the starch, **therefore** the crumb hardens · payoff, the freezer stops it · close.
- FACTS: "fastest just above freezing" needs a food-science source; until one is recorded, it is marked "source needed" and the film does not state it.
