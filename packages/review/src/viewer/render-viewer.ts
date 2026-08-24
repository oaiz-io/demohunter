import type {
  ReviewChangeSet,
  ReviewDefinition,
} from "../authoring/review-types.js";
import type { ResolvedDiffEvidence, ResolvedEvidence } from "../evidence/resolve-evidence.js";
import type { ChangedFile } from "../git/git-types.js";
import { renderDiagram } from "./diagrams.js";
import { VIEWER_CSS, VIEWER_JS } from "./viewer-assets.js";
import { listReviewSections, orderedChapters, type ReviewViewModel } from "./view-model.js";

export type RenderedViewerFile = {
  /** Review-root-relative POSIX path. */
  path: string;
  contents: string;
  mediaType: string;
};

export const VIEWER_INDEX_FILE = "index.html";
export const VIEWER_DATA_FILE = "data/review.json";

/**
 * Renders the complete local review website.
 *
 * The output is a pure function of the view model: same review plus same diff
 * produces byte-identical files. Nothing is fetched at runtime, so the site
 * works from a cold disk with the network unplugged.
 */
export function renderViewer(model: ReviewViewModel): RenderedViewerFile[] {
  const diagrams = model.review.architecture?.map(renderDiagram) ?? [];
  const files: RenderedViewerFile[] = [
    { path: VIEWER_INDEX_FILE, contents: renderIndexHtml(model, diagrams), mediaType: "text/html" },
    { path: "assets/viewer.css", contents: VIEWER_CSS, mediaType: "text/css" },
    { path: "assets/viewer.js", contents: VIEWER_JS, mediaType: "text/javascript" },
    { path: VIEWER_DATA_FILE, contents: `${JSON.stringify(toViewerData(model), null, 2)}\n`, mediaType: "application/json" },
  ];

  for (const diagram of diagrams) {
    files.push({
      path: `diagrams/${diagram.id}.svg`,
      contents: `${diagram.svg}\n`,
      mediaType: "image/svg+xml",
    });
  }

  return files;
}

function toViewerData(model: ReviewViewModel): Record<string, unknown> {
  return {
    generatedAt: model.generatedAt,
    generatorVersion: model.generatorVersion,
    review: {
      id: model.review.id,
      title: model.review.title,
      subtitle: model.review.subtitle,
      pullRequest: model.review.pullRequest,
      problem: model.review.problem,
      goals: model.review.goals ?? [],
      nonGoals: model.review.nonGoals ?? [],
    },
    git: {
      baseRef: model.git.baseRef,
      baseSha: model.git.baseSha,
      headRef: model.git.headRef,
      headSha: model.git.headSha,
      mergeBaseSha: model.git.mergeBaseSha,
      mergeBaseCandidates: model.git.mergeBaseCandidates,
      headIsMergeCommit: model.git.headIsMergeCommit,
      worktreeClean: model.git.worktree.clean,
    },
    coverage: {
      totalCount: model.coverage.totalCount,
      accountedCount: model.coverage.accountedCount,
      complete: model.coverage.complete,
      unaccounted: model.coverage.unaccounted,
    },
    sections: listReviewSections(model),
    verification: model.verification,
    video: model.video,
  };
}

function renderIndexHtml(
  model: ReviewViewModel,
  diagrams: ReturnType<typeof renderDiagram>[],
): string {
  const sections = listReviewSections(model);
  const chapters = orderedChapters(model);

  return [
    "<!doctype html>",
    '<html lang="en" data-review-id="' + escapeHtml(model.review.id) + '">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="referrer" content="no-referrer" />',
    // The served CSP header is authoritative; this meta tag keeps the same
    // guarantees when the file is opened directly from disk.
    '<meta http-equiv="Content-Security-Policy" content="' + escapeHtml(VIEWER_CSP) + '" />',
    "<title>" + escapeHtml(model.review.title) + " · DemoHunter Review</title>",
    '<link rel="stylesheet" href="assets/viewer.css" />',
    "</head>",
    "<body>",
    '<div class="layout">',
    renderSidebar(model, sections),
    "<main>",
    renderMasthead(model),
    renderOverview(model),
    renderArchitecture(model, diagrams),
    renderReviewOrder(model),
    chapters.map((chapter) => renderChapter(model, chapter)).join(""),
    renderVerification(model),
    renderRisks(model),
    renderCompatibility(model),
    renderSecurity(model),
    renderQuestions(model),
    renderCoverage(model),
    renderWalkthrough(model),
    renderFooter(model),
    "</main>",
    "</div>",
    '<script src="assets/viewer.js"></script>',
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export const VIEWER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function renderSidebar(model: ReviewViewModel, sections: ReturnType<typeof listReviewSections>): string {
  const groups: Array<{ label: string; kinds: string[] }> = [
    { label: "Context", kinds: ["overview", "architecture", "review-order"] },
    { label: "Changes", kinds: ["chapter"] },
    { label: "Evidence", kinds: ["verification", "risks", "compatibility", "security", "questions", "coverage"] },
    { label: "Walkthrough", kinds: ["walkthrough"] },
  ];

  const nav = groups
    .map((group) => {
      const entries = sections.filter((section) => group.kinds.includes(section.kind));

      if (entries.length === 0) {
        return "";
      }

      return (
        '<div class="nav-group">' + escapeHtml(group.label) + "</div>"
        + entries
          .map((section) => '<a href="#' + escapeHtml(section.id) + '">' + escapeHtml(section.title) + "</a>")
          .join("")
      );
    })
    .join("");

  return (
    '<aside class="sidebar">'
    + "<h1>" + escapeHtml(model.review.title) + "</h1>"
    + '<p class="sub">' + escapeHtml(model.review.subtitle ?? "DemoHunter Review") + "</p>"
    + '<nav class="nav">' + nav + "</nav>"
    + "</aside>"
  );
}

function renderMasthead(model: ReviewViewModel): string {
  const pullRequest = model.review.pullRequest;
  const prLabel = pullRequest?.number === undefined ? undefined : "#" + pullRequest.number;
  const facts = [
    fact("base", model.git.baseRef + " @ " + shortSha(model.git.baseSha)),
    fact("merge-base", shortSha(model.git.mergeBaseSha)),
    fact("head", model.git.headRef + " @ " + shortSha(model.git.headSha)),
    fact("files changed", String(model.coverage.totalCount)),
    fact("coverage", model.coverage.accountedCount + "/" + model.coverage.totalCount),
    fact("verification", model.verification.status),
    fact("worktree", model.git.worktree.clean ? "clean" : model.git.worktree.entries.length + " pending"),
    ...(prLabel === undefined ? [] : [fact("pull request", prLabel)]),
    ...(pullRequest?.author === undefined ? [] : [fact("author", pullRequest.author)]),
  ].join("");

  const warnings: string[] = [];

  if (model.git.mergeBaseCandidates.length > 1) {
    warnings.push(
      "This comparison has " + model.git.mergeBaseCandidates.length
        + " merge-base candidates (" + model.git.mergeBaseCandidates.map(shortSha).join(", ")
        + "). The lowest sorted candidate was used; the range may be ambiguous.",
    );
  }
  if (model.git.headIsMergeCommit) {
    warnings.push(
      "HEAD is a merge commit with " + model.git.headParents.length
        + " parents, so the diff includes everything merged in, not just this branch's own commits.",
    );
  }
  if (!model.git.worktree.clean) {
    warnings.push(
      "The work tree was not clean when this artifact was generated, so the reviewed range may not match what is on disk.",
    );
  }

  return (
    '<div class="masthead">'
    + "<h2>" + escapeHtml(model.review.title) + "</h2>"
    + "<p>" + escapeHtml(model.review.problem.summary) + "</p>"
    + '<div class="facts">' + facts + "</div>"
    + "</div>"
    + warnings.map((warning) => '<div class="warn-banner">' + escapeHtml(warning) + "</div>").join("")
  );
}

function renderOverview(model: ReviewViewModel): string {
  const problem = model.review.problem;
  const blocks: string[] = [];

  blocks.push(
    card(
      "Problem",
      paragraph(problem.summary) + (problem.detail === undefined ? "" : paragraph(problem.detail)),
    ),
  );

  if ((problem.inScope ?? []).length > 0 || (problem.outOfScope ?? []).length > 0) {
    blocks.push(
      '<div class="grid-2">'
      + (problem.inScope === undefined ? "" : card("In scope", list(problem.inScope)))
      + (problem.outOfScope === undefined ? "" : card("Out of scope", list(problem.outOfScope)))
      + "</div>",
    );
  }

  if ((model.review.goals ?? []).length > 0 || (model.review.nonGoals ?? []).length > 0) {
    blocks.push(
      '<div class="grid-2">'
      + (model.review.goals === undefined ? "" : card("Goals", list(model.review.goals)))
      + (model.review.nonGoals === undefined ? "" : card("Non-goals", list(model.review.nonGoals)))
      + "</div>",
    );
  }

  for (const decision of model.review.decisions ?? []) {
    blocks.push(
      card(
        "Decision: " + decision.title,
        paragraph(decision.rationale)
          + ((decision.alternatives ?? []).length === 0
            ? ""
            : '<p class="section-intent">Alternatives considered</p>' + list(decision.alternatives ?? [])),
      ),
    );
  }

  return section("overview", "Problem and scope", undefined, blocks.join(""));
}

function renderArchitecture(
  model: ReviewViewModel,
  diagrams: ReturnType<typeof renderDiagram>[],
): string {
  if (diagrams.length === 0) {
    return "";
  }

  const body = diagrams
    .map((diagram) =>
      card(
        diagram.title,
        (diagram.caption === undefined ? "" : paragraph(diagram.caption))
          + '<div class="diagram-wrap" id="diagram-' + escapeHtml(diagram.id) + '">' + diagram.svg + "</div>",
      ),
    )
    .join("");

  return section("architecture", "Architecture", "Component and sequence views of the target design.", body);
}

function renderReviewOrder(model: ReviewViewModel): string {
  const entries = model.review.reviewOrder ?? [];

  if (entries.length === 0) {
    return "";
  }

  const chapterById = new Map(model.review.chapters.map((chapter) => [chapter.id, chapter]));
  const body = '<ol class="tight">'
    + entries
      .map((entry) => {
        const chapter = chapterById.get(entry.chapterId);
        return (
          "<li><a href=\"#chapter-" + escapeHtml(entry.chapterId) + "\">"
          + escapeHtml(chapter?.title ?? entry.chapterId)
          + "</a> — " + escapeHtml(entry.why) + "</li>"
        );
      })
      .join("")
    + "</ol>";

  return section(
    "review-order",
    "Recommended review order",
    "Read the change in this order; each step assumes the previous one.",
    card("Order", body),
  );
}

function renderChapter(model: ReviewViewModel, chapter: ReviewChangeSet): string {
  const evidence = model.evidenceByChapter[chapter.id] ?? [];
  const fileRows = chapter.files
    .map((path) => {
      const file = model.files.find((candidate) => candidate.path === path);
      return (
        "<tr><td class=\"path\">" + escapeHtml(path) + "</td>"
        + "<td>" + statusBadge(file?.status ?? "modified") + "</td>"
        + "<td class=\"num\"><span class=\"plus\">+" + (file?.insertions ?? 0) + "</span> "
        + "<span class=\"minus\">-" + (file?.deletions ?? 0) + "</span></td></tr>"
      );
    })
    .join("");

  const checks = chapter.reviewerChecks.length === 0
    ? '<p class="empty">No explicit reviewer checks were authored for this change set.</p>'
    : '<ul class="tight">'
      + chapter.reviewerChecks
        .map(
          (check) =>
            "<li><b>" + escapeHtml(check.check) + "</b>"
            + (check.detail === undefined ? "" : " — " + escapeHtml(check.detail))
            + "</li>",
        )
        .join("")
      + "</ul>";

  const body =
    card(
      "Intent",
      paragraph(chapter.intent) + (chapter.detail === undefined ? "" : paragraph(chapter.detail)),
    )
    + card(
      "Files in this change set",
      '<table class="data"><thead><tr><th>Path</th><th>Status</th><th>Lines</th></tr></thead><tbody>'
        + fileRows
        + "</tbody></table>",
    )
    + (evidence.length === 0
      ? ""
      : card("Focused evidence", evidence.map(renderEvidence).join("")))
    + card("What to verify", checks);

  return section("chapter-" + chapter.id, chapter.title, chapter.intent, body);
}

function renderEvidence(evidence: ResolvedEvidence): string {
  const header =
    '<header><span class="path">' + escapeHtml(evidence.path) + "</span>"
    + (evidence.kind === "diff"
      ? statusBadge(evidence.status)
        + (evidence.previousPath === undefined
          ? ""
          : '<span class="badge">from ' + escapeHtml(evidence.previousPath) + "</span>")
      : '<span class="badge">' + escapeHtml(evidence.side) + " "
        + evidence.startLine + "-" + evidence.endLine + "</span>")
    + '<span class="anchor" title="Content-addressed evidence anchor">' + evidence.anchor.slice(0, 16) + "</span>"
    + "</header>";
  const note = evidence.note === undefined ? "" : '<div class="note">' + escapeHtml(evidence.note) + "</div>";
  const body = evidence.kind === "diff" ? renderDiffBody(evidence) : renderCodeBody(evidence);

  return '<div class="evidence" id="evidence-' + escapeHtml(evidence.id) + '">' + header + note + body + "</div>";
}

function renderDiffBody(evidence: ResolvedDiffEvidence): string {
  const rows = evidence.hunks
    .map((hunk) => {
      const hunkRow = '<tr class="hunk"><td colspan="3">' + escapeHtml(hunk.header) + "</td></tr>";
      const lines = hunk.lines
        .map((line) => {
          const marker = line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
          return (
            '<tr class="' + line.kind + '">'
            + '<td class="ln">' + (line.oldLine ?? "") + "</td>"
            + '<td class="ln">' + (line.newLine ?? "") + "</td>"
            + '<td class="code"><span class="mark">' + escapeHtml(marker) + "</span>" + escapeHtml(line.text) + "</td>"
            + "</tr>"
          );
        })
        .join("");
      return hunkRow + lines;
    })
    .join("");
  const omitted = evidence.totalHunks > evidence.hunks.length
    ? '<div class="note">Showing ' + evidence.hunks.length + " of " + evidence.totalHunks
      + " hunks in this file; the rest are accounted for but not called out here.</div>"
    : "";

  return omitted + '<div class="diff"><table><tbody>' + rows + "</tbody></table></div>";
}

function renderCodeBody(evidence: Extract<ResolvedEvidence, { kind: "code" }>): string {
  const rows = evidence.lines
    .map(
      (line) =>
        '<tr><td class="ln">' + line.line + '</td><td class="code">' + escapeHtml(line.text) + "</td></tr>",
    )
    .join("");

  return '<div class="diff"><table><tbody>' + rows + "</tbody></table></div>";
}

function renderVerification(model: ReviewViewModel): string {
  if (model.verification.results.length === 0) {
    return "";
  }

  const rows = model.verification.results
    .map(
      (result) =>
        card(
          result.label,
          '<p class="section-intent">' + statusBadge(result.status)
            + ' <code>' + escapeHtml(result.command.join(" ")) + "</code>"
            + " · exit " + (result.exitCode === null ? "n/a" : String(result.exitCode))
            + " (expected " + result.expectedExitCode + ")"
            + " · " + formatDuration(result.durationMs)
            + (result.timedOut ? " · timed out" : "")
            + "</p>"
            + (result.rationale === undefined ? "" : paragraph(result.rationale))
            + (result.outputTail.trim().length === 0
              ? ""
              : '<pre class="output">'
                + (result.outputTruncated ? escapeHtml("… output truncated …\n") : "")
                + escapeHtml(result.outputTail.trim())
                + "</pre>"),
        ),
    )
    .join("");

  const intent = model.verification.ran
    ? "These commands were executed while generating this artifact. Exit codes are real."
    : "These commands were declared but not executed for this artifact. Regenerate with --run-verification to record real results.";

  return section("verification", "Verification", intent, rows);
}

function renderRisks(model: ReviewViewModel): string {
  const risks = model.review.risks ?? [];

  if (risks.length === 0) {
    return "";
  }

  const body = risks
    .map((risk) =>
      card(
        risk.title,
        '<p class="section-intent">' + statusBadge(risk.severity) + " risk</p>"
          + paragraph(risk.detail)
          + (risk.mitigation === undefined ? "" : paragraph("Mitigation: " + risk.mitigation)),
      ),
    )
    .join("");

  return section("risks", "Risks", "What could go wrong, and what limits the blast radius.", body);
}

function renderCompatibility(model: ReviewViewModel): string {
  const notes = model.review.compatibility ?? [];

  if (notes.length === 0) {
    return "";
  }

  const rows = notes
    .map(
      (note) =>
        "<tr><td>" + escapeHtml(note.area) + "</td>"
        + "<td>" + statusBadge(note.impact) + "</td>"
        + "<td>" + escapeHtml(note.detail)
        + (note.migration === undefined ? "" : "<br /><b>Migration:</b> " + escapeHtml(note.migration))
        + "</td></tr>",
    )
    .join("");

  return section(
    "compatibility",
    "Compatibility",
    "How existing users and existing artifacts are affected.",
    card(
      "Impact by area",
      '<table class="data"><thead><tr><th>Area</th><th>Impact</th><th>Detail</th></tr></thead><tbody>'
        + rows
        + "</tbody></table>",
    ),
  );
}

function renderSecurity(model: ReviewViewModel): string {
  const notes = model.review.security ?? [];

  if (notes.length === 0) {
    return "";
  }

  const body = notes
    .map((note) =>
      card(
        note.title,
        paragraph(note.detail)
          + (note.control === undefined
            ? ""
            : '<p class="section-intent">Control: <code>' + escapeHtml(note.control) + "</code></p>"),
      ),
    )
    .join("");

  return section("security", "Security", "Boundaries this change touches and how they are enforced.", body);
}

function renderQuestions(model: ReviewViewModel): string {
  const questions = model.review.reviewerQuestions ?? [];

  if (questions.length === 0) {
    return "";
  }

  const body = '<ol class="tight">'
    + questions
      .map(
        (question) =>
          "<li><b>" + escapeHtml(question.question) + "</b>"
          + (question.context === undefined ? "" : "<br />" + escapeHtml(question.context))
          + "</li>",
      )
      .join("")
    + "</ol>";

  return section(
    "questions",
    "Reviewer questions",
    "Open decisions where the author explicitly wants a second opinion.",
    card("Questions", body),
  );
}

function renderCoverage(model: ReviewViewModel): string {
  const percent = model.coverage.totalCount === 0
    ? 100
    : Math.round((model.coverage.accountedCount / model.coverage.totalCount) * 100);
  const ownerByPath = new Map(model.coverage.assignments.map((assignment) => [assignment.path, assignment]));
  const rows = model.files
    .map((file) => {
      const owner = ownerByPath.get(file.path);
      const flags = [
        file.isBinary ? "binary" : "",
        file.isSubmodule ? "submodule" : "",
        file.isModeOnly ? "mode-only" : "",
        file.isGenerated ? "generated" : "",
      ].filter((flag) => flag.length > 0);

      return (
        "<tr>"
        + '<td class="path">' + escapeHtml(file.path)
        + (file.previousPath === undefined
          ? ""
          : '<br /><span class="badge">renamed from ' + escapeHtml(file.previousPath) + "</span>")
        + "</td>"
        + "<td>" + statusBadge(file.status) + "</td>"
        + '<td class="num">' + renderLineStat(file) + "</td>"
        + "<td>" + (flags.length === 0 ? "" : flags.map((flag) => '<span class="badge">' + flag + "</span>").join(" ")) + "</td>"
        + "<td>"
        + (owner === undefined
          ? '<span class="badge badge-failed">unaccounted</span>'
          : owner.kind === "chapter"
            ? '<a href="#chapter-' + escapeHtml(owner.ownerId) + '">' + escapeHtml(owner.ownerTitle) + "</a>"
            : escapeHtml(owner.ownerTitle) + ' <span class="badge">group</span>')
        + "</td>"
        + "</tr>"
      );
    })
    .join("");

  const groups = model.coverage.groups.length === 0
    ? ""
    : card(
        "Coverage groups",
        '<ul class="tight">'
          + model.coverage.groups
            .map(
              (group) =>
                "<li><b>" + escapeHtml(group.title) + "</b> (" + group.paths.length + " file"
                + (group.paths.length === 1 ? "" : "s") + ") — " + escapeHtml(group.rationale) + "</li>",
            )
            .join("")
          + "</ul>",
      );

  return section(
    "coverage",
    "Changed-file coverage",
    "Every file in merge-base..HEAD, and what explains it.",
    card(
      "Accounting",
      '<div class="coverage-summary">'
        + "<b>" + model.coverage.accountedCount + " / " + model.coverage.totalCount + " files</b>"
        + '<div class="meter' + (model.coverage.complete ? "" : " is-incomplete") + '"><i style="width:'
        + percent + '%"></i></div>'
        + "<span>" + percent + "%</span>"
        + "</div>"
        + '<table class="data"><thead><tr><th>Path</th><th>Status</th><th>Lines</th><th>Flags</th><th>Accounted by</th></tr></thead><tbody>'
        + rows
        + "</tbody></table>",
    ) + groups,
  );
}

function renderWalkthrough(model: ReviewViewModel): string {
  if (model.video === null) {
    return "";
  }

  const chapterButtons = model.video.chapters
    .map(
      (chapter) =>
        '<button type="button" data-chapter-start="' + chapter.startMs + '">'
        + '<span class="t">' + formatTimecode(chapter.startMs) + "</span>"
        + escapeHtml(chapter.title)
        + "</button>",
    )
    .join("");

  return section(
    "walkthrough",
    "Narrated walkthrough",
    "The same review, narrated over this page. " + formatDuration(model.video.durationMs) + ".",
    card(
      "Video",
      '<div class="walkthrough"><video data-review-video controls preload="metadata" poster="'
        + escapeHtml(model.video.poster) + '">'
        + '<source src="' + escapeHtml(model.video.video) + '" type="video/mp4" />'
        + '<track kind="captions" src="' + escapeHtml(model.video.captionsVtt)
        + '" srclang="en" label="English" default />'
        + "</video></div>"
        + (chapterButtons.length === 0 ? "" : '<div class="chapter-list">' + chapterButtons + "</div>"),
    ),
  );
}

function renderFooter(model: ReviewViewModel): string {
  return (
    '<p class="footer-note">Generated by DemoHunter Review ' + escapeHtml(model.generatorVersion)
    + " on " + escapeHtml(model.generatedAt)
    + " from " + escapeHtml(model.git.baseRef) + " (" + shortSha(model.git.mergeBaseSha) + ") to "
    + escapeHtml(model.git.headRef) + " (" + shortSha(model.git.headSha) + "). "
    + "Local-only: this page makes no network requests.</p>"
  );
}

function renderLineStat(file: ChangedFile): string {
  if (file.isBinary) {
    return '<span class="badge">binary</span>';
  }

  return (
    '<span class="plus">+' + file.insertions + "</span> "
    + '<span class="minus">-' + file.deletions + "</span>"
  );
}

function section(id: string, title: string, intent: string | undefined, body: string): string {
  return (
    '<section id="' + escapeHtml(id) + '">'
    + "<h2>" + escapeHtml(title) + "</h2>"
    + (intent === undefined ? "" : '<p class="section-intent">' + escapeHtml(intent) + "</p>")
    + body
    + "</section>"
  );
}

function card(title: string, body: string): string {
  return '<div class="card"><h3>' + escapeHtml(title) + "</h3>" + body + "</div>";
}

function list(items: readonly string[]): string {
  return '<ul class="tight">' + items.map((item) => "<li>" + escapeHtml(item) + "</li>").join("") + "</ul>";
}

function paragraph(text: string): string {
  return "<p>" + escapeHtml(text) + "</p>";
}

function fact(label: string, value: string): string {
  return '<span class="fact"><b>' + escapeHtml(label) + "</b><span>" + escapeHtml(value) + "</span></span>";
}

function statusBadge(value: string): string {
  return '<span class="badge badge-' + escapeHtml(value) + '">' + escapeHtml(value) + "</span>";
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return durationMs + "ms";
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes === 0 ? seconds + "s" : minutes + "m " + String(seconds).padStart(2, "0") + "s";
}

function formatTimecode(startMs: number): string {
  const totalSeconds = Math.floor(startMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes + ":" + String(seconds).padStart(2, "0");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type { ReviewDefinition };
