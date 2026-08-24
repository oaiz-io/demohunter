import { describe, expect, test } from "bun:test";

import {
  makeChangedFiles,
  makeReviewDefinition,
  makeViewModel,
} from "../test-support/view-model-fixture.ts";
import { escapeHtml, renderViewer, VIEWER_CSP, VIEWER_DATA_FILE, VIEWER_INDEX_FILE } from "./render-viewer.js";

describe("renderViewer", () => {
  test("emits a self-contained file set", () => {
    const files = renderViewer(makeViewModel());
    const paths = files.map((file) => file.path).sort();

    expect(paths).toEqual([
      "assets/viewer.css",
      "assets/viewer.js",
      "data/review.json",
      "diagrams/arch.svg",
      "diagrams/flow.svg",
      VIEWER_INDEX_FILE,
    ].sort());
  });

  test("is a pure function of the model", () => {
    expect(renderViewer(makeViewModel())).toEqual(renderViewer(makeViewModel()));
  });

  test("references no remote origin from any emitted file", () => {
    for (const file of renderViewer(makeViewModel())) {
      // The SVG namespace is an identifier, not something a browser fetches.
      const contents = file.contents.replaceAll('xmlns="http://www.w3.org/2000/svg"', "");

      expect(contents).not.toMatch(/https?:\/\//);
      expect(contents).not.toMatch(/(?:src|href)="\/\//);
      expect(contents).not.toContain("@import url(");
      expect(contents).not.toContain("fetch(");
      expect(contents).not.toContain("XMLHttpRequest");
    }
  });

  test("pins a closed content security policy in the document itself", () => {
    const html = indexHtml(makeViewModel());

    expect(VIEWER_CSP).toContain("default-src 'none'");
    expect(VIEWER_CSP).toContain("connect-src 'none'");
    expect(VIEWER_CSP).toContain("frame-ancestors 'none'");
    expect(VIEWER_CSP).not.toContain("script-src 'unsafe-inline'");
    expect(html).toContain(escapeHtml(VIEWER_CSP));
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
  });

  test("renders every authored section", () => {
    const html = indexHtml(makeViewModel());

    for (const id of [
      "overview",
      "architecture",
      "review-order",
      "chapter-core",
      "verification",
      "risks",
      "compatibility",
      "security",
      "questions",
      "coverage",
    ]) {
      expect(html).toContain(`<section id="${id}">`);
    }
  });

  test("shows the git range, coverage, and verification as masthead facts", () => {
    const html = indexHtml(makeViewModel());

    expect(html).toContain("main @ 111111111111");
    expect(html).toContain("333333333333");
    expect(html).toContain("HEAD @ 222222222222");
    expect(html).toContain("<span>2/2</span>");
    expect(html).toContain("passed");
  });

  test("escapes authored text so a review cannot inject markup", () => {
    const review = makeReviewDefinition({
      title: '</title><script>alert("xss")</script>',
      problem: { summary: '<img src=x onerror="alert(1)">' },
    });
    const html = indexHtml(makeViewModel({ review }));

    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    // Exactly one real script tag: the local viewer bundle.
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  test("escapes diff content so a changed file cannot inject markup", () => {
    const model = makeViewModel();
    model.evidenceByChapter.core![0]!.kind === "diff"
      && (model.evidenceByChapter.core![0] as { hunks: Array<{ lines: Array<{ text: string }> }> }).hunks[0]!.lines.push({
        kind: "addition",
        oldLine: null,
        newLine: 3,
        text: '<script>fetch("https://evil.example")</script>',
      } as never);

    const html = indexHtml(model);

    expect(html).not.toContain('<script>fetch(');
    expect(html).toContain("&lt;script&gt;fetch(");
  });

  test("escapes a path containing a quote in the coverage table", () => {
    const model = makeViewModel({ files: makeChangedFiles(['src/we"ird.ts']) });
    const html = indexHtml(model);

    expect(html).toContain("src/we&quot;ird.ts");
  });

  test("warns when the range is ambiguous, HEAD is a merge, or the tree was dirty", () => {
    const model = makeViewModel();
    model.git.mergeBaseCandidates = ["3".repeat(40), "9".repeat(40)];
    model.git.headIsMergeCommit = true;
    model.git.headParents = ["3".repeat(40), "9".repeat(40)];
    model.git.worktree = {
      clean: false,
      entries: [{ code: " M", path: "src/app.ts" }],
      untracked: [],
      unmerged: [],
    };

    const html = indexHtml(model);

    expect(html).toContain("merge-base candidates");
    expect(html).toContain("HEAD is a merge commit");
    expect(html).toContain("work tree was not clean");
  });

  test("marks incomplete coverage in the meter and in the table", () => {
    const review = makeReviewDefinition({ coverage: { groups: [] } });
    const model = makeViewModel({ review, files: makeChangedFiles(["src/app.ts", "src/orphan.ts"]) });
    const html = indexHtml(model);

    expect(html).toContain('class="meter is-incomplete"');
    expect(html).toContain('badge-failed">unaccounted');
  });

  test("omits the walkthrough section until a video exists, then embeds it with captions", () => {
    expect(indexHtml(makeViewModel())).not.toContain('id="walkthrough"');

    const html = indexHtml(
      makeViewModel({
        video: {
          video: "video.mp4",
          poster: "poster.jpg",
          captionsVtt: "captions.vtt",
          durationMs: 125_000,
          chapters: [
            { title: "Problem and scope", startMs: 0 },
            { title: "Coverage", startMs: 90_000 },
          ],
        },
      }),
    );

    expect(html).toContain('<section id="walkthrough">');
    expect(html).toContain('<source src="video.mp4" type="video/mp4" />');
    expect(html).toContain('<track kind="captions" src="captions.vtt"');
    expect(html).toContain('data-chapter-start="90000"');
    expect(html).toContain("1:30");
  });

  test("writes a machine-readable view of the same facts", () => {
    const files = renderViewer(makeViewModel());
    const data = JSON.parse(
      files.find((file) => file.path === VIEWER_DATA_FILE)!.contents,
    ) as Record<string, any>;

    expect(data.git.headSha).toBe("2".repeat(40));
    expect(data.git.mergeBaseSha).toBe("3".repeat(40));
    expect(data.coverage).toEqual({
      totalCount: 2,
      accountedCount: 2,
      complete: true,
      unaccounted: [],
    });
    expect(data.verification.status).toBe("passed");
    expect(data.sections.map((section: { id: string }) => section.id)).toContain("coverage");
  });

  test("declares an accurate media type for every emitted file", () => {
    for (const file of renderViewer(makeViewModel())) {
      expect(file.mediaType).toBe(
        file.path.endsWith(".html")
          ? "text/html"
          : file.path.endsWith(".css")
            ? "text/css"
            : file.path.endsWith(".js")
              ? "text/javascript"
              : file.path.endsWith(".json")
                ? "application/json"
                : "image/svg+xml",
      );
    }
  });
});

describe("escapeHtml", () => {
  test("escapes every character that can break out of markup or an attribute", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  test("escapes the ampersand first so entities are not double-decoded", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

function indexHtml(model: Parameters<typeof renderViewer>[0]): string {
  return renderViewer(model).find((file) => file.path === VIEWER_INDEX_FILE)!.contents;
}
