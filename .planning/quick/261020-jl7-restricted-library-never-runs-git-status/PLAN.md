# Quick task 261020-jl7: restricted library never runs git status

## Problem

`studio --restricted` (the desktop app's untrusted mode) restricted only the opened folder before the first library scan. The scan ran `git status` in every other worktree that `git worktree list` returns. The main checkout in a parent folder, or a sibling linked worktree, was still trusted at that time. A crafted repository's shared `.git/config` can name a clean filter (`filter.<driver>.clean`), and `git status` runs it for a file whose stat changed. Result: code execution when a person opens a folder without trusting it.

## Tasks

1. `LocalLibrary` knows that it is restricted (`LocalLibrary.open(root, { restricted })`). It restricts the root at construction. In each scan, it restricts every listed worktree before any git work or render runs there. It never calls `cachedWorktreeState` (`git status`) while restricted.
2. `serveLibrary` passes `restricted` into the library, not only a `restrictFolder(root)` call.
3. Regression test in `worktrees.test.ts`: a repository with a clean filter and a stat-dirty file in the main checkout. Its linked worktree is opened with `serveLibrary(..., { restricted: true })`. The filter must not run.
