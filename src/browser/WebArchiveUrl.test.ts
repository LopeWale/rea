import { describe, expect, it } from "vitest";

import {
  parseWebArchiveUrl,
  unwrapWebArchiveUrl,
  webArchiveRawUrl,
} from "./WebArchiveUrl.js";

describe("Wayback Machine snapshot URLs", () => {
  it("parses snapshot URLs with and without a modifier", () => {
    const snapshot = parseWebArchiveUrl(
      "https://web.archive.org/web/20260219070517/https://studio.example.test/",
    );
    expect(snapshot).toEqual({
      archive_origin: "https://web.archive.org",
      timestamp: "20260219070517",
      original_url: "https://studio.example.test/",
    });
    expect(
      parseWebArchiveUrl(
        "https://web.archive.org/web/20260219070517id_/https://studio.example.test/app.js?v=3",
      ),
    ).toEqual({
      archive_origin: "https://web.archive.org",
      timestamp: "20260219070517",
      original_url: "https://studio.example.test/app.js?v=3",
    });
  });

  it("rejects non-archive hosts, non-HTTP originals, and malformed paths", () => {
    expect(parseWebArchiveUrl("https://studio.example.test/")).toBeNull();
    expect(
      parseWebArchiveUrl("https://web.archive.org/web/2026/ftp://x.test/"),
    ).toBeNull();
    expect(parseWebArchiveUrl("https://web.archive.org/web/")).toBeNull();
    expect(parseWebArchiveUrl("not a url")).toBeNull();
  });

  it("addresses unmodified archived bytes and unwraps redirect targets", () => {
    const snapshot = {
      archive_origin: "https://web.archive.org",
      timestamp: "20260219070517",
      original_url: "https://studio.example.test/",
    };
    expect(
      webArchiveRawUrl(snapshot, "https://studio.example.test/_app/start.js"),
    ).toBe(
      "https://web.archive.org/web/20260219070517id_/https://studio.example.test/_app/start.js",
    );
    expect(
      unwrapWebArchiveUrl(
        "https://web.archive.org/web/20260101000000id_/https://studio.example.test/moved.js",
        snapshot,
      ),
    ).toBe("https://studio.example.test/moved.js");
    expect(
      unwrapWebArchiveUrl("https://studio.example.test/moved.js", snapshot),
    ).toBeNull();
  });
});
