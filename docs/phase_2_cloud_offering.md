# Phase 2 - Cloud Offering

> Historical proposal. These hosted features are not part of the current open-source product and are not a public delivery commitment. The local CLI does not depend on OAIZ services.

## Summary

Build a hosted product that takes generated OSS output from `.demohunter/<tour-id>/` and turns it into a shareable watch link with hosted video, transcript, chapters, managed TTS, and project history.

Important sequencing decision:

* v1 Cloud hosts generated OSS output
* it does not start with full remote generation
* hosting first is the right move because many teams still need to generate locally against local apps, preview environments, or seeded local data

## Relationship to OSS

The OSS CLI stays self-sufficient. Cloud is additive.

The shared contract is the generated output written by OSS:

```text
.demohunter/<tour-id>/
  video.mp4
  captions.srt
  captions.vtt
  chapters.json
  manifest.json
  poster.jpg
  audio/
```

Cloud should ingest that output without requiring source code or access to the original repo.

## Primary users

* Dev/product/design teams sharing narrated walkthroughs
* Teams that do not want to manage their own TTS keys
* Teams that want one watch link per feature, commit, or release

## Non-goals for v1

* Full cloud generation of arbitrary private local apps
* Browser-based timeline editor
* Loom replacement for unscripted recordings

## SaaS v1 architecture

### Frontend

* Next.js app
* org/project/video pages
* watch page with transcript/chapter panel
* upload UI
* share permissions UI

### Backend

* API service
* background worker
* Postgres for metadata
* object storage for uploads, video, audio, and posters
* queue for ingest, transcode, and TTS jobs
* CDN in front of video and static assets

## Product modes

### Mode 1 - hosted generated output

User generates locally with OSS CLI, then uploads generated output.

Cloud hosts the video and returns a watch link.

### Mode 2 - managed TTS + local generation

User still generates locally, but the CLI uses the hosted TTS endpoint instead of the user's own OpenAI key.

### Mode 3 - cloud generation

Later, for teams with reachable preview/staging environments, a cloud worker can execute the script remotely.

## Core cloud features

### V1

* auth + orgs + projects
* generated-output upload
* watch pages
* transcript/chapter navigation
* unlisted/private/public share modes
* version history per project

### V2

* hosted TTS endpoint
* org-level narration cache
* CLI auth token
* CLI `publish` command

### V3

* regenerate from stored output manifest + changed voice/settings
* comments
* GitHub links such as commit SHA and PR number
* project dashboard

### V4

* optional cloud generation workers
* preview environment integrations
* scheduled regenerations
* latest-demo-for-branch semantics

## Managed TTS design

For cloud mode, create a hosted TTS API:

```text
POST /api/tts/speech
```

Input:

* text
* model
* voice
* instructions
* format

Output:

* audio file URL or streamed bytes
* durationMs
* cacheKey

Server-side cache key should mirror OSS logic:

* text
* model
* voice
* instructions
* format
* provider version
* cache schema version

Behavior:

* if identical segment already exists in org cache, return it
* otherwise synthesize once and store
* log cache hit rate

## API surface

### Initial endpoints

* `POST /api/uploads/output/upload-url`
* `POST /api/uploads/output/complete`
* `POST /api/videos`
* `GET /watch/:videoId`
* `GET /api/videos/:videoId`
* `POST /api/tts/speech`
* `POST /api/publish`
* `GET /api/projects/:projectId/videos`

### Later endpoints

* `POST /api/generations`
* `GET /api/generations/:generationId`
* `POST /api/generations/:generationId/retry`

## Data model

### `organizations`

* id
* name
* billing plan

### `projects`

* id
* organizationId
* name
* slug

### `videos`

* id
* projectId
* title
* status
* visibility
* durationMs
* posterUrl
* videoUrl
* manifestUrl
* transcriptUrl
* createdBy
* commitSha
* branch
* prNumber

### `generated_outputs`

* id
* videoId
* checksum
* manifestVersion
* uploadedAt

### `narration_segments`

* id
* organizationId
* cacheKey
* provider
* model
* voice
* instructions
* durationMs
* audioUrl
* textHash
* createdAt

### `generation_jobs`

* id
* projectId
* status
* logs
* startedAt
* finishedAt

## CLI-to-cloud integration

Add to OSS CLI later:

```bash
demohunter login
demohunter publish .demohunter/billing-overview
demohunter generate demos/billing.tour.ts --publish
demohunter generate demos/billing.tour.ts --tts-provider hosted
```

Behavior:

* `login` stores cloud auth token
* `publish` uploads generated output and returns watch URL
* hosted TTS mode swaps local OpenAI provider for remote cloud TTS provider

## Acceptance criteria

Cloud v1 is done when:

* a user can upload generated output from the OSS CLI
* the system returns a stable watch URL
* the watch page shows video, transcript, and chapters
* no source code is required or uploaded by default
* videos can be public, unlisted, or org-private

Cloud v2 is done when:

* CLI can use hosted TTS instead of local OpenAI
* identical narration segments reuse org-level cache
* user sees one watch link without managing TTS keys

Cloud v3 is done when:

* project history shows all demo revisions
* metadata like commit SHA and PR number appear on watch pages

Cloud v4 is done when:

* cloud workers can generate against reachable preview/staging URLs
* remote generations succeed without local machine involvement

## Roadmap

### Phase B0 - generated-output hosting foundation

Build:

* auth
* orgs/projects
* generated-output upload
* watch page
* object storage + CDN
* manifest ingestion

Exit:

* hosted watch links work from CLI-produced generated-output directories

### Phase B1 - managed TTS

Build:

* hosted TTS API
* server-side cache
* CLI auth + provider switch
* usage tracking

Exit:

* user can generate locally without their own OpenAI key

### Phase B2 - publish workflow

Build:

* `demohunter publish`
* `--publish` generate flag
* project/video history
* commit metadata

Exit:

* generate + upload is one command

### Phase B3 - collaboration

Build:

* comments
* access control
* branch/release grouping
* notifications/webhooks

Exit:

* teams can use it as the canonical demo history for a project

### Phase B4 - cloud generation

Build:

* queue + workers
* browser runner images
* user-provided environment configuration
* generation retry/debug logs

Exit:

* remote generations work for supported environments

## Risks and mitigations

### Risk: cloud generation is much harder than hosting

Mitigation:

* do not make it part of v1

### Risk: scripts become flaky as UI changes

Mitigation:

* require stable selectors
* keep app-specific setup inside user Playwright code
* surface last successful step and screenshot on failure

### Risk: TTS costs grow with repeated boilerplate narration

Mitigation:

* org-level cache
* reusable narration segments in timeline manifest

### Risk: private code/privacy concerns

Mitigation:

* v1 upload contains generated output, not source
* cloud generation is opt-in later
