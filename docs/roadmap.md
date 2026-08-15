# Roadmap: Video Generation Agent

## Phase 1 — MVP: Single Topic → Single Video

**Goal:** Turn one natural-language prompt into one narrated video, end-to-end.

### Deliverables

- [ ] **CLI command:** `demohunter-video generate "<prompt>" --style <name>`
- [ ] **Programmatic API:** `import { generateVideo } from "@demohunter/video-gen"`
- [ ] **Content generator:** LLM call that produces `content-spec.json` from a prompt
- [ ] **Content spec schema:** Zod-validated JSON schema for lesson structure (title, slides with headings, bullet lists, code blocks, paragraph text, narration)
- [ ] **Template engine:** Renders `content-spec.json` into static HTML/CSS/JS
- [ ] **Single-page slides:** CSS transitions between slides (fade, slide-left)
- [ ] **Tour compiler:** Generates `.tour.ts` from `content-spec.json`
- [ ] **DemoHunter bridge:** Serves HTML locally, invokes `demohunter generate`
- [ ] **Style presets (3):** minimal (clean white), terminal (dark + monospace), notebook (warm + serif)
- [ ] **Error recovery:** Retry on LLM failure, clean up temp files on SIGINT
- [ ] **Pre-flight checks:** Verify ffmpeg, Playwright browsers, `OPENAI_API_KEY` before starting

### Explicit Non-Goals for Phase 1

- Multi-page lessons
- Interactive elements (click to reveal, tabs, accordions)
- Diagrams (Mermaid, ASCII)
- Personalization or audience targeting
- Multi-language content generation
- Background music
- Series/chapter support
- Repair loops (if video fails, just report error)

### Success Criteria

- User runs `demohunter-video generate "What is a binary tree?" --style minimal`
- Gets a `.demohunter/binary-tree/video.mp4` with narration, captions, and chapters
- Entire flow completes without manual intervention
- Intermediate artifacts (content-spec, HTML, tour.ts) are inspectable on disk

---

## Phase 2 — Rich Content

**Goal:** Multi-page lessons with diagrams, code highlighting, interactive elements, and repair loops.

### Deliverables

- [ ] **Multi-page lessons:** Content spec supports `pages[]` with navigation between them
- [ ] **Chapter support:** Maps page structure to DemoHunter `chapter()` calls
- [ ] **Code syntax highlighting:** Integrate highlight.js or Shiki for rendered code blocks
- [ ] **Diagrams:** Support Mermaid and ASCII diagrams, rendered to SVG before recording
- [ ] **Interactive elements:**
  - Click-to-reveal (answer hidden behind click)
  - Tabs (switch between content panes)
  - Accordions (expand/collapse sections)
  - All mapped to deterministic Playwright actions in the tour compiler
- [ ] **Repair loop:** If DemoHunter fails (element not found, timeout), analyze the error, patch the tour or content, retry up to 2 times
- [ ] **`--duration` flag:** Control target video length (e.g., `--duration 5m`)
- [ ] **Progress feedback:** Show pipeline stage progress during generation

### Success Criteria

- User generates a lesson on "Rust ownership" with code blocks that have syntax highlighting
- Lesson includes a Mermaid diagram of the borrow checker flow
- Tour navigates between pages using the table of contents

---

## Phase 3 — Personalization

**Goal:** Style marketplace, audience targeting, multilingual support, lesson series.

### Deliverables

- [ ] **`--audience` flag:** `beginner`, `intermediate`, `expert` — affects content depth, jargon level, assumptions
- [ ] **`--language` flag:** Multilingual content generation (narration language follows from content language)
- [ ] **Style marketplace:** User-defined CSS theme packs
  - `demohunter-video styles install <package>` 
  - Styles published as npm packages or local directories
- [ ] **Lesson series:** `demohunter-video series "Rust for beginners" --lessons 5`
  - LLM plans a course outline
  - Each lesson builds on previous ones
  - Series manifest tracks completion
- [ ] **Voice selection tied to style presets:** Each preset can specify a default TTS voice and model
- [ ] **Background music:** Optional ambient background track mixed at low volume
  - Built-in CC0 tracks
  - User-provided audio files

### Success Criteria

- User runs `demohunter-video series "Linear algebra" --lessons 5 --audience beginner`
- Gets 5 sequentially numbered videos, each building on the last
- Switches to `--language sv` and gets a Swedish-narrated lesson

---

## Phase 4 — The Primer Vision

**Goal:** Adaptive, interactive AI teacher. This is where the project begins to approach the full Primer concept.

### Deliverables

- [ ] **Interactive Q&A:** Pause video, learner asks a question, agent generates a follow-up explanation
- [ ] **Learner model:** Track what has been taught across sessions
- [ ] **Spaced repetition:** Review previous concepts at optimal intervals
- [ ] **Adaptive content:** Adjust lesson depth and pace based on engagement signals
- [ ] **Multi-modal lessons:** Combine video segments, interactive coding exercises, and quizzes in one lesson
- [ ] **Offline Primer:** Bundle lessons with all assets for offline use (no network needed after download)
- [ ] **Progress tracking:** Visual progress map showing what's been learned and what's next

### Success Criteria

- A learner can start a topic, ask questions during the lesson, get answers, and have the system remember what they've learned
- The experience feels like a conversation with a knowledgeable tutor, not a pre-recorded video

---

## Timeline (Aspirational)

| Phase | Estimated | Status |
|-------|-----------|--------|
| Phase 1 — MVP | 4-6 weeks | Not started |
| Phase 2 — Rich Content | 6-8 weeks | Not started |
| Phase 3 — Personalization | 8-12 weeks | Not started |
| Phase 4 — Primer Vision | Ongoing | Not started |

---

## Dependencies

| Dependency | Used by | Status |
|------------|---------|--------|
| DemoHunter (local) | Recording/narration engine | ✅ Available (v1.1) |
| OpenAI API (GPT-4.6+) | Content generation | ✅ Available |
| OpenAI TTS | Narration (via DemoHunter) | ✅ Available |
| Playwright | Browser automation (via DemoHunter) | ✅ Available |
| ffmpeg | Video composition (via DemoHunter) | ✅ Available |
| highlight.js or Shiki | Code highlighting (Phase 2) | TBD |
| Mermaid | Diagram rendering (Phase 2) | TBD |
