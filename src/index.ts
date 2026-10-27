// The Page Search API client: upload a PDF, then search its pages with up to 10 questions at once.

export const VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://api.search.pageindex.ai/v1";
const API_KEY_ENV = "PAGEINDEX_SEARCH_API_KEY";
// Retried, after a short wait that doubles: the server was busy or briefly unreachable.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/** A path (Node), or the file's bytes. */
export type FileInput = string | Uint8Array | ArrayBuffer | Blob;

export interface Document {
  object: "document";
  id: string;
  status: "processing" | "ready" | "failed";
  filename: string | null;
  pages: number | null; // null while processing
  bytes: number;
  created_at: string;
  error?: string; // when failed
  duplicate?: boolean; // on uploads: the same file was already uploaded; this is that document
}

export interface Page {
  page: number; // numbered from 1
  relevance: number; // from 0 to 1: how likely the page helps answer the question
}

export interface Answer {
  question: string;
  pages: Page[]; // most relevant first
}

export interface SearchResult {
  object: "search";
  id: string;
  document_id: string;
  results: Answer[]; // one for each question, in the order asked
  failed_pages: number[]; // pages the model could not read; not charged
  usage: { pages: number; questions: number; billable_pages: number; cost_usd: number; balance_usd: number };
  seconds: number;
}

export interface UsageDay {
  date: string;
  uploads: number;
  pages_uploaded: number;
  searches: number;
  questions: number;
  billable_pages: number;
  storage_cost_usd: number;
  cost_usd: number;
}

export interface Usage {
  object: "usage";
  start: string;
  end: string;
  data: UsageDay[];
  total: Omit<UsageDay, "date">;
  balance_usd: number;
  storage: { stored_pages: number; free_pages: number; price_per_1000_pages_month_usd: number };
}

export interface PageSearchOptions {
  /** Defaults to the PAGEINDEX_SEARCH_API_KEY environment variable. */
  apiKey?: string;
  baseURL?: string;
  /** Milliseconds a request may take. */
  timeout?: number;
  maxRetries?: number;
  /** A fetch to use instead of the global one. */
  fetch?: typeof fetch;
}

/** An error the API returned, or a document that could not be made. */
export class PageSearchError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(message: string, options: { status?: number; code?: string; requestId?: string } = {}) {
    const parts = [options.code ? `${options.code}: ${message}` : message];
    if (options.status) parts.push(`(HTTP ${options.status})`);
    if (options.requestId) parts.push(`[${options.requestId}]`);
    super(parts.join(" "));
    this.name = "PageSearchError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
  }
}

/**
 * A client for the Page Search API.
 *
 *     const client = new PageSearch(); // reads PAGEINDEX_SEARCH_API_KEY
 *     const doc = await client.upload("report.pdf");
 *     const result = await client.search(doc, ["What was revenue in 2024?"]);
 *     for (const answer of result.results) console.log(answer.question, answer.pages.map((p) => p.page));
 */
export class PageSearch {
  readonly baseURL: string;
  readonly maxRetries: number;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly fetch: typeof fetch;

  constructor(options: PageSearchOptions = {}) {
    const env = typeof process !== "undefined" ? process.env : {};
    const apiKey = options.apiKey ?? env[API_KEY_ENV];
    if (!apiKey) {
      throw new PageSearchError(`No API key: pass apiKey or set ${API_KEY_ENV}. ` +
        "Create one at https://search.pageindex.ai/console/keys.");
    }
    this.apiKey = apiKey;
    this.baseURL = (options.baseURL ?? env.PAGEINDEX_SEARCH_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // Documents

  /**
   * Uploads a PDF: a path (in Node) or its bytes. Uploading the same file again returns its document.
   *
   * With wait (the default), resolves once the document is ready to search, or rejects if it failed; most are
   * ready in a second or two. Without it, resolves at once; the document may still be processing.
   */
  async upload(file: FileInput, options: { filename?: string; wait?: boolean; timeout?: number } = {}): Promise<Document> {
    let blob: Blob;
    let filename = options.filename;
    if (typeof file === "string") {
      const { readFile } = await import("node:fs/promises");
      const { basename } = await import("node:path");
      blob = new Blob([await readFile(file)], { type: "application/pdf" });
      filename ??= basename(file);
    } else if (file instanceof Blob) {
      blob = file;
      filename ??= (file as { name?: string }).name;
    } else {
      blob = new Blob([file as BlobPart], { type: "application/pdf" });
    }
    const form = new FormData();
    form.append("file", blob, filename || "document.pdf");
    const doc = await this.request<Document>("POST", "/documents", { body: form });
    return options.wait === false ? doc : this.wait(doc, { timeout: options.timeout });
  }

  /** The document once it is ready; rejects if it failed or is not ready within timeout (milliseconds). */
  async wait(document: Document | string, options: { timeout?: number; interval?: number } = {}): Promise<Document> {
    let doc = typeof document === "string" ? await this.document(document) : document;
    const deadline = Date.now() + (options.timeout ?? 300_000);
    while (doc.status === "processing") {
      if (Date.now() > deadline) throw new PageSearchError(`Document ${doc.id} is still processing.`);
      await sleep(options.interval ?? 1000);
      doc = await this.document(doc.id);
    }
    if (doc.status === "failed") {
      throw new PageSearchError(doc.error || `Document ${doc.id} could not be processed.`, { code: "document_failed" });
    }
    return doc;
  }

  document(documentId: string): Promise<Document> {
    return this.request<Document>("GET", `/documents/${encodeURIComponent(documentId)}`);
  }

  /** One page of your documents, newest first; after: the last id of the previous page. */
  async documents(options: { limit?: number; after?: string } = {}): Promise<Document[]> {
    const page = await this.request<{ data: Document[] }>("GET", "/documents", {
      query: { limit: options.limit ?? 20, after: options.after },
    });
    return page.data;
  }

  /** Every document you have, newest first, a page at a time. */
  async *iterDocuments(): AsyncGenerator<Document> {
    let after: string | undefined;
    for (;;) {
      const page = await this.request<{ data: Document[]; has_more: boolean }>("GET", "/documents", {
        query: { limit: 100, after },
      });
      yield* page.data;
      if (!page.has_more || !page.data.length) return;
      after = page.data[page.data.length - 1].id;
    }
  }

  /** Deletes a document and its pages; searches of it then fail. */
  async delete(document: Document | string): Promise<void> {
    await this.request("DELETE", `/documents/${encodeURIComponent(id(document))}`);
  }

  // Search

  /**
   * Asks up to 10 questions about a document. For each, the pages that help answer it, most relevant first.
   *
   * Without topK, each answer lists the pages likely to help: relevance 0.3 or more, or 0.2 or more when fewer
   * than 3 are, and possibly none. With it, exactly topK pages.
   */
  search(document: Document | string, questions: string | string[], options: { topK?: number } = {}): Promise<SearchResult> {
    const body: Record<string, unknown> = { questions: typeof questions === "string" ? [questions] : questions };
    if (options.topK !== undefined) body.top_k = options.topK;
    return this.request<SearchResult>("POST", `/documents/${encodeURIComponent(id(document))}/search`, { json: body });
  }

  // Account

  /**
   * Uploads, searches and cost by day (UTC, dates as YYYY-MM-DD; the last 30 days by default), your credit
   * balance and the pages you have stored.
   */
  usage(options: { start?: string; end?: string } = {}): Promise<Usage> {
    return this.request<Usage>("GET", "/usage", { query: options });
  }

  // Plumbing

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string | number | undefined>; json?: unknown; body?: FormData } = {},
  ): Promise<T> {
    const url = new URL(this.baseURL + path);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": `pageindex-search-js/${VERSION}`,
    };
    let body: BodyInit | undefined = options.body;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeout) });
      } catch (error) {
        if (attempt >= this.maxRetries) throw new PageSearchError(`Could not reach the API: ${(error as Error).message}`);
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (RETRY_STATUSES.has(response.status) && attempt < this.maxRetries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      return parse<T>(response);
    }
  }
}

function id(document: Document | string): string {
  return typeof document === "string" ? document : document.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = undefined;
  }
  if (response.ok && data && typeof data === "object") return data as T;
  const error = (data as { error?: { message?: string; code?: string; request_id?: string } } | undefined)?.error ?? {};
  throw new PageSearchError(error.message || text.slice(0, 200) || response.statusText, {
    status: response.status,
    code: error.code,
    requestId: error.request_id ?? response.headers.get("x-request-id") ?? undefined,
  });
}

export default PageSearch;
