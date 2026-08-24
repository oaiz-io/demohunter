import { describe, expect, test } from "bun:test";

import {
  makeReviewLock,
  FIXTURE_DIGEST,
  FIXTURE_HEAD_SHA,
} from "../test-support/lock-fixture.ts";
import {
  parseReviewLock,
  REVIEW_LOCK_FILE_NAME,
  REVIEW_LOCK_VERSION,
  serializeReviewLock,
} from "./review-lock.js";

describe("reviewLockSchema", () => {
  test("accepts a well-formed lock", () => {
    const lock = makeReviewLock();

    expect(parseReviewLock(JSON.parse(JSON.stringify(lock)))).toEqual(lock);
    expect(REVIEW_LOCK_FILE_NAME).toBe("review.lock.json");
  });

  test("rejects an abbreviated sha", () => {
    const lock = makeReviewLock();
    lock.git.headSha = FIXTURE_HEAD_SHA.slice(0, 7);

    expect(() => parseReviewLock(lock)).toThrow();
  });

  test("rejects an unknown lock version", () => {
    expect(() => parseReviewLock({ ...makeReviewLock(), lockVersion: REVIEW_LOCK_VERSION + 1 })).toThrow();
  });

  test("rejects unknown top-level keys instead of silently dropping them", () => {
    expect(() => parseReviewLock({ ...makeReviewLock(), somethingElse: true })).toThrow();
  });

  test("rejects artifact paths that could escape the review directory", () => {
    for (const badPath of ["../escape.html", "/etc/passwd", "C:/windows", "nested\\file.html", "a/./b"]) {
      const lock = makeReviewLock({
        artifacts: [
          { path: badPath, mediaType: "text/html", checksum: { algorithm: "sha256", byteSize: 1, hex: FIXTURE_DIGEST } },
        ],
      });

      expect(() => parseReviewLock(lock)).toThrow();
    }
  });

  test("accepts a nested POSIX artifact path", () => {
    const lock = makeReviewLock({
      artifacts: [
        {
          path: "assets/viewer.css",
          mediaType: "text/css",
          checksum: { algorithm: "sha256", byteSize: 12, hex: FIXTURE_DIGEST },
        },
      ],
    });

    expect(parseReviewLock(lock).artifacts[0]?.path).toBe("assets/viewer.css");
  });

  test("requires at least one merge-base candidate", () => {
    const lock = makeReviewLock();
    lock.git.mergeBaseCandidates = [];

    expect(() => parseReviewLock(lock)).toThrow();
  });

  test("rejects a verification result with an unknown status", () => {
    const lock = makeReviewLock();
    lock.verification = {
      status: "maybe" as never,
      ran: true,
      results: [],
    };

    expect(() => parseReviewLock(lock)).toThrow();
  });
});

describe("serializeReviewLock", () => {
  test("is stable and newline-terminated", () => {
    const lock = makeReviewLock();

    expect(serializeReviewLock(lock)).toBe(serializeReviewLock(makeReviewLock()));
    expect(serializeReviewLock(lock).endsWith("}\n")).toBe(true);
    expect(parseReviewLock(JSON.parse(serializeReviewLock(lock)))).toEqual(lock);
  });
});
