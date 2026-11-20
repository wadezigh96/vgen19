/**
 * Page reader: fetch a source page and extract its readable text.
 *
 * Fetched web content is UNTRUSTED DATA: it is text to extract facts
 * from, never instructions to follow. The reader only returns text;
 * it never executes anything it fetched, and it never calls a tool.
 *
 * A failed fetch (network error, non-2xx status, timeout, or a page
 * over the size cap) throws a `PageReadError`; the researcher
 * catches it and records the source as failed, so one dead page
 * never kills a research run.
 * No HTML-parser dependency: extraction is a small set of regex
 * passes (strip scripts/styles/tags, decode common entities, collapse
 * whitespace), which is enough for the researcher's needs.
 */

/** Minimal fetch response shape the reader needs. */
export interface PageFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  /** Response headers, when the fetch exposes them (the real fetch does). */
  readonly headers?: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

/** Minimal injectable fetch for page reads. Defaults to global fetch. */
export type PageFetchFn = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<PageFetchResponse>;

/** Default page-fetch timeout: 10 seconds. */
export const DEFAULT_PAGE_TIMEOUT_MS = 10_000;

/** Default maximum page size: 2 MB. Pages over the cap are refused. */
export const DEFAULT_MAX_PAGE_BYTES = 2_000_000;

/** A page read failed: network error, non-2xx status, timeout, or oversize. */
export class PageReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageReadError";
  }
}

/** The readable content of one source page. */
export interface PageContent {
  /** URL the page was read from. */
  url: string;
  /** Page title, when the page carries one. */
  title?: string;
  /** Readable text extracted from the page. */
  text: string;
}

/** A page reader: read one URL and return its readable content. */
export type ReadPageFn = (url: string) => Promise<PageContent>;

/** Decode the HTML entities that appear in ordinary page text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCharCode(Number(code)),
    );
}

/**
 * Extract readable text from raw HTML: drop scripts, styles, and
 * other non-content elements, strip the remaining tags, decode
 * entities, and collapse whitespace. Pure, so tests can check it
 * without any fetch.
 */
export function extractReadableText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]*>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

/** Extract the page title from raw HTML, when it carries one. */
function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] === undefined ? "" : decodeEntities(match[1]);
  const cleaned = title.replace(/\s+/g, " ").trim();
  return cleaned === "" ? undefined : cleaned;
}

export interface CreatePageReaderOptions {
  /** Injectable fetch; defaults to the global fetch. Tests stub this. */
  fetchFn?: PageFetchFn;
  /** Per-page timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Maximum page size in bytes. Defaults to 2 MB. */
  maxPageBytes?: number;
}

const defaultPageFetch: PageFetchFn = (url, init) => fetch(url, init);

/**
 * Build a page reader. A failed fetch throws `PageReadError` with the
 * reason; callers record it and move on.
 */
export function createPageReader(
  options: CreatePageReaderOptions = {},
): ReadPageFn {
  const fetchFn = options.fetchFn ?? defaultPageFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;

  return async (url: string): Promise<PageContent> => {
    const controller = new AbortController();
    // Race the fetch against a timeout as well as passing the abort
    // signal: a hung fetch that ignores the signal must still fail.
    const timeoutError = new PageReadError(
      `Timed out reading ${url} after ${timeoutMs} ms.`,
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        fetchFn(url, { signal: controller.signal }),
        timeoutPromise,
      ]).catch((error: unknown) => {
        if (error instanceof PageReadError) {
          throw error;
        }
        throw new PageReadError(
          `Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (!response.ok) {
        throw new PageReadError(
          `Failed to fetch ${url}: HTTP ${response.status}.`,
        );
      }
      // Refuse an oversize page before reading its body when the
      // server declares the length; the byte check below catches a
      // missing or lying Content-Length.
      const declaredLength = response.headers?.get("content-length");
      const declaredBytes =
        declaredLength === null || declaredLength === undefined
          ? Number.NaN
          : Number(declaredLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxPageBytes) {
        throw new PageReadError(
          `Page ${url} is too large: ${declaredBytes} bytes declared, ` +
            `over the ${maxPageBytes} byte cap.`,
        );
      }
      const html = await response.text();
      const bodyBytes = Buffer.byteLength(html, "utf-8");
      if (bodyBytes > maxPageBytes) {
        throw new PageReadError(
          `Page ${url} is too large: ${bodyBytes} bytes, over the ` +
            `${maxPageBytes} byte cap.`,
        );
      }
      return {
        text: extractReadableText(html),
        title: extractTitle(html),
        url,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  };
}
