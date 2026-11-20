import { describe, expect, it } from "vitest";

import {
  createPageReader,
  extractReadableText,
  PageReadError,
  type PageFetchFn,
} from "../src/research/index.js";

const SAMPLE_HTML = `
<!doctype html>
<html>
<head>
  <title>Zanara election announced</title>
  <style>body { color: red; }</style>
  <script>console.log("tracking");</script>
</head>
<body>
  <nav>Home &amp; About</nav>
  <h1>Zanara election announced</h1>
  <p>The Zanara Election Commission announced a general election
     for 31 December 2026.</p>
  <p>Opposition parties welcomed the news.</p>
  <script>window.evil = true;</script>
</body>
</html>
`;

describe("extractReadableText", () => {
  it("strips scripts, styles, and tags and collapses whitespace", () => {
    const text = extractReadableText(SAMPLE_HTML);

    expect(text).toContain("Zanara election announced");
    expect(text).toContain(
      "The Zanara Election Commission announced a general election for 31 December 2026.",
    );
    expect(text).toContain("Opposition parties welcomed the news.");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("window.evil");
    expect(text).not.toContain("<p>");
    expect(text).not.toMatch(/  +/);
  });

  it("decodes common HTML entities", () => {
    expect(extractReadableText("<p>Fish &amp; Chips &lt;3 &quot;quoted&quot;</p>")).toBe(
      'Fish & Chips <3 "quoted"',
    );
  });

  it("returns an empty string for a page with no readable text", () => {
    expect(extractReadableText("<html><head><script>x();</script></head></html>")).toBe(
      "",
    );
  });
});

describe("createPageReader", () => {
  it("reads a page and returns its title and readable text", async () => {
    const fetchFn: PageFetchFn = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(SAMPLE_HTML),
      });
    const readPage = createPageReader({ fetchFn });

    const page = await readPage("https://example.invalid/news/zanara");

    expect(page.url).toBe("https://example.invalid/news/zanara");
    expect(page.title).toBe("Zanara election announced");
    expect(page.text).toContain("general election for 31 December 2026");
    expect(page.text).not.toContain("console.log");
  });

  it("records a non-2xx fetch as a PageReadError, not a crash", async () => {
    const fetchFn: PageFetchFn = () =>
      Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });
    const readPage = createPageReader({ fetchFn });

    const error = await readPage("https://example.invalid/missing").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PageReadError);
    expect((error as Error).message).toContain("404");
  });

  it("records a network failure as a PageReadError", async () => {
    const fetchFn: PageFetchFn = () =>
      Promise.reject(new Error("connection reset"));
    const readPage = createPageReader({ fetchFn });

    await expect(readPage("https://example.invalid/down")).rejects.toBeInstanceOf(
      PageReadError,
    );
  });

  it("times out a fetch that never answers", async () => {
    const fetchFn: PageFetchFn = () =>
      new Promise(() => {
        // Never resolves: the reader's timeout must still fire.
      });
    const readPage = createPageReader({ fetchFn, timeoutMs: 10 });

    const error = await readPage("https://example.invalid/slow").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PageReadError);
    expect((error as Error).message).toMatch(/timed out/i);
  });

  it("refuses a page whose Content-Length exceeds the size cap without reading it", async () => {
    let textCalled = false;
    const fetchFn: PageFetchFn = () =>
      Promise.resolve({
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-length" ? "101" : null,
        },
        ok: true,
        status: 200,
        text: () => {
          textCalled = true;
          return Promise.resolve("x".repeat(101));
        },
      });
    const readPage = createPageReader({ fetchFn, maxPageBytes: 100 });

    const error = await readPage("https://example.invalid/huge").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PageReadError);
    expect((error as Error).message).toMatch(/too large/i);
    expect(textCalled).toBe(false);
  });

  it("refuses a page whose body exceeds the size cap when no Content-Length is sent", async () => {
    const fetchFn: PageFetchFn = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("x".repeat(101)),
      });
    const readPage = createPageReader({ fetchFn, maxPageBytes: 100 });

    const error = await readPage("https://example.invalid/huge").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PageReadError);
    expect((error as Error).message).toMatch(/too large/i);
  });

  it("reads a page whose body is exactly at the size cap", async () => {
    const fetchFn: PageFetchFn = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(`<p>${"x".repeat(97)}</p>`),
      });
    const readPage = createPageReader({ fetchFn, maxPageBytes: 104 });

    const page = await readPage("https://example.invalid/exact");

    expect(page.text).toBe("x".repeat(97));
  });
});
