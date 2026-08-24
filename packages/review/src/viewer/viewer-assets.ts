/**
 * Static viewer assets.
 *
 * They are inlined as module constants rather than shipped as separate source
 * files so the built package stays self-contained: no asset-copy build step,
 * no runtime file lookup relative to `dist`, and no possibility of a viewer
 * shipping without its stylesheet.
 */

export const VIEWER_CSS = `:root {
  color-scheme: dark;
  --bg: #0b1017;
  --panel: #111a25;
  --panel-2: #0f1620;
  --border: #22303f;
  --text: #e6edf6;
  --muted: #93a5ba;
  --accent: #4f9dff;
  --add: #2ea043;
  --add-bg: rgba(46, 160, 67, 0.14);
  --del: #f85149;
  --del-bg: rgba(248, 81, 73, 0.14);
  --warn: #d29922;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.6;
}
a { color: var(--accent); }
code, pre, .mono { font-family: var(--mono); }
.layout { display: grid; grid-template-columns: 288px minmax(0, 1fr); min-height: 100vh; }
.sidebar {
  position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto;
  border-right: 1px solid var(--border); background: var(--panel-2); padding: 24px 18px;
}
.sidebar h1 { font-size: 16px; margin: 0 0 4px; letter-spacing: -0.01em; }
.sidebar .sub { color: var(--muted); font-size: 12.5px; margin: 0 0 18px; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav a {
  display: block; padding: 6px 10px; border-radius: 7px; text-decoration: none;
  color: var(--muted); font-size: 13.5px; border-left: 2px solid transparent;
}
.nav a:hover { background: #16202e; color: var(--text); }
.nav a.is-active { background: #16202e; color: var(--text); border-left-color: var(--accent); }
.nav .nav-group { margin-top: 12px; font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: #5e7086; padding: 0 10px; }
main { padding: 32px 40px 96px; max-width: 1180px; }
section { margin-bottom: 44px; scroll-margin-top: 24px; }
section > h2 { font-size: 21px; margin: 0 0 6px; letter-spacing: -0.01em; }
section > .section-intent { color: var(--muted); margin: 0 0 16px; }
.masthead { border: 1px solid var(--border); background: var(--panel); border-radius: 14px; padding: 22px 24px; margin-bottom: 32px; }
.masthead h2 { margin: 0 0 6px; font-size: 25px; letter-spacing: -0.02em; }
.masthead p { margin: 0 0 14px; color: var(--muted); }
.facts { display: flex; flex-wrap: wrap; gap: 8px; }
.fact {
  display: inline-flex; gap: 7px; align-items: baseline; background: var(--panel-2);
  border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; font-size: 12px;
}
.fact b { color: var(--muted); font-weight: 500; }
.fact span { font-family: var(--mono); font-size: 11.5px; }
.card { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 18px 20px; margin-bottom: 14px; }
.card > h3 { margin: 0 0 8px; font-size: 16px; }
.card > h3 .idx { color: var(--muted); font-family: var(--mono); font-size: 12.5px; margin-right: 8px; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
ul.tight, ol.tight { margin: 6px 0 0; padding-left: 20px; }
ul.tight li, ol.tight li { margin: 3px 0; }
.badge {
  display: inline-block; border-radius: 999px; padding: 1px 9px; font-size: 11px;
  border: 1px solid var(--border); background: var(--panel-2); color: var(--muted);
  font-family: var(--mono); letter-spacing: 0.01em;
}
.badge-added { color: var(--add); border-color: rgba(46,160,67,.4); }
.badge-deleted { color: var(--del); border-color: rgba(248,81,73,.4); }
.badge-renamed, .badge-copied { color: var(--accent); border-color: rgba(79,157,255,.4); }
.badge-high { color: var(--del); border-color: rgba(248,81,73,.5); }
.badge-medium { color: var(--warn); border-color: rgba(210,153,34,.5); }
.badge-low { color: var(--muted); }
.badge-passed { color: var(--add); border-color: rgba(46,160,67,.45); }
.badge-failed { color: var(--del); border-color: rgba(248,81,73,.45); }
.badge-not-run { color: var(--warn); border-color: rgba(210,153,34,.45); }
.badge-breaking { color: var(--del); border-color: rgba(248,81,73,.45); }
.badge-behavioral { color: var(--warn); border-color: rgba(210,153,34,.45); }
.badge-additive { color: var(--add); border-color: rgba(46,160,67,.45); }
.evidence { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin: 14px 0 0; background: var(--panel-2); }
.evidence header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 14px; border-bottom: 1px solid var(--border); background: #0d141d; }
.evidence header .path { font-family: var(--mono); font-size: 12.5px; color: var(--text); }
.evidence header .anchor { margin-left: auto; font-family: var(--mono); font-size: 10.5px; color: #5e7086; }
.evidence .note { padding: 10px 14px; color: var(--muted); font-size: 13.5px; border-bottom: 1px solid var(--border); }
.diff { margin: 0; overflow-x: auto; font-family: var(--mono); font-size: 12.4px; line-height: 1.55; }
.diff table { border-collapse: collapse; width: 100%; }
.diff td { padding: 0 8px; white-space: pre; vertical-align: top; }
.diff td.ln { width: 1%; text-align: right; color: #55677d; user-select: none; border-right: 1px solid var(--border); background: #0b1119; }
.diff tr.addition td.code { background: var(--add-bg); }
.diff tr.deletion td.code { background: var(--del-bg); }
.diff tr.hunk td { background: #101b28; color: #7d93ad; font-size: 11.5px; padding: 3px 8px; }
.diff td.code { width: 100%; }
.diff .mark { color: #6d8199; }
.diagram-wrap { border: 1px solid var(--border); background: var(--panel-2); border-radius: 12px; padding: 12px; overflow-x: auto; }
.diagram-wrap svg { display: block; max-width: 100%; height: auto; }
table.data { width: 100%; border-collapse: collapse; font-size: 13.2px; }
table.data th, table.data td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
table.data th { color: var(--muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; }
table.data td.path { font-family: var(--mono); font-size: 12.2px; word-break: break-all; }
table.data td.num { font-family: var(--mono); text-align: right; white-space: nowrap; }
.plus { color: var(--add); }
.minus { color: var(--del); }
.coverage-summary { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.meter { flex: 1; height: 8px; border-radius: 999px; background: #16202e; overflow: hidden; }
.meter > i { display: block; height: 100%; background: var(--add); }
.meter.is-incomplete > i { background: var(--del); }
pre.output { margin: 8px 0 0; padding: 10px 12px; background: #0b1119; border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; font-size: 12.2px; color: #b7c6d8; white-space: pre-wrap; }
.walkthrough video { width: 100%; border-radius: 12px; border: 1px solid var(--border); background: #000; }
.chapter-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.chapter-list button {
  font: inherit; font-size: 12.5px; color: var(--text); background: var(--panel-2);
  border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; cursor: pointer;
}
.chapter-list button:hover { border-color: var(--accent); }
.chapter-list button .t { color: var(--muted); font-family: var(--mono); font-size: 11px; margin-right: 6px; }
.empty { color: var(--muted); font-style: italic; }
.footer-note { color: #5e7086; font-size: 12px; border-top: 1px solid var(--border); padding-top: 16px; }
.warn-banner { border: 1px solid rgba(210,153,34,.5); background: rgba(210,153,34,.08); color: #f0d08a; border-radius: 10px; padding: 12px 16px; margin-bottom: 18px; font-size: 13.5px; }
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
  main { padding: 24px 18px 64px; }
}
`;

export const VIEWER_JS = `(function () {
  "use strict";

  var sections = Array.prototype.slice.call(document.querySelectorAll("main section[id]"));
  var links = Array.prototype.slice.call(document.querySelectorAll(".nav a[href^='#']"));
  var linkById = {};

  links.forEach(function (link) {
    linkById[link.getAttribute("href").slice(1)] = link;
  });

  function activate(id) {
    links.forEach(function (link) { link.classList.remove("is-active"); });
    var active = linkById[id];
    if (active) { active.classList.add("is-active"); }
  }

  if ("IntersectionObserver" in window && sections.length > 0) {
    var observer = new IntersectionObserver(function (entries) {
      var visible = entries
        .filter(function (entry) { return entry.isIntersecting; })
        .sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top; })[0];
      if (visible) { activate(visible.target.id); }
    }, { rootMargin: "-10% 0px -75% 0px", threshold: 0 });
    sections.forEach(function (section) { observer.observe(section); });
  }

  var video = document.querySelector("video[data-review-video]");
  if (video) {
    Array.prototype.slice.call(document.querySelectorAll("[data-chapter-start]")).forEach(function (button) {
      button.addEventListener("click", function () {
        var startMs = Number(button.getAttribute("data-chapter-start"));
        if (isFinite(startMs)) {
          video.currentTime = startMs / 1000;
          var playback = video.play();
          if (playback && typeof playback.catch === "function") { playback.catch(function () {}); }
        }
      });
    });
  }

  // The recorded walkthrough waits for this flag before it starts narrating, so
  // the video never captures a half-rendered page.
  document.documentElement.setAttribute("data-review-ready", "true");
})();
`;
