// The Page Search API client: upload PDFs, then search their pages with up to 10 questions at once.

export const VERSION = "0.4.2";
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
  metadata: Metadata; // your own keys
}

/** A document's own keys: strings, numbers and booleans, at most 16. */
export type Metadata = Record<string, string | number | boolean>;

/**
 * Picks documents by their metadata: {"ticker": "MMM"}, {"year": {"$gte": 2020}}, {"$or": [...]}. Conditions are $eq,
 * $ne, $gt, $gte, $lt, $lte, $in and $nin; $and and $or combine filters.
 */
export type Filter = Record<string, unknown>;

export interface Collection {
  object: "collection";
  id: string;
  name: string;
  documents: number; // how many documents it holds
  created_at: string;
}

export interface Page {
  page: number; // numbered from 1
  relevance: number; // from 0 to 1: how likely the page helps answer the question
}

/** A document a search found pages in, with those pages. */
export interface FoundDocument {
  document_id: string;
  filename: string | null;
  page_count: number;
  metadata: Metadata;
  relevance: number | null; // how likely it holds the answer; null when the search named it (document)
  pages: Page[]; // the pages that help answer the question, most relevant first
  failed_pages: number[]; // pages that could not be read; not charged
}

export interface Answer {
  question: string;
  documents: FoundDocument[]; // most relevant first; one when the search named a document
}

export interface SearchResult {
  object: "search";
  id: string;
  results: Answer[]; // one for each question, in the order asked
  failed_documents: string[];
  processing_documents: string[]; // still being made; not searched
  // documents: judged to find which to open (none when the search named one); pages: searched in those opened.
  usage: { documents: number; pages: number; questions: number; cost_usd: number; balance_usd: number };
  seconds: number;
}

export interface DocumentMatch {
  document_id: string;
  filename: string | null;
  pages: number;
  metadata: Metadata;
  relevance: number; // from 0 to 1: how likely the document holds what answers the question
}

export interface DocumentAnswer {
  question: string;
  documents: DocumentMatch[]; // most relevant first
}

export interface DocumentSearchResult {
  object: "document_search";
  id: string;
  results: DocumentAnswer[]; // one for each question, in the order asked
  failed_documents: string[]; // could not be judged just now; not charged
  processing_documents: string[]; // still being made; not searched
  // Each document is priced as a page.
  usage: { documents: number; questions: number; billable_documents: number; cost_usd: number; balance_usd: number };
  seconds: number;
}

/** One metadata key: the types of its values (more than one when documents disagree) and how many documents have it. */
export interface SchemaKey {
  key: string;
  types: ("string" | "number" | "boolean")[];
  documents: number;
  /** For numbers: the least and greatest. */
  min?: number;
  max?: number;
  /** For strings: the commonest values, with how many documents have each. */
  values?: { value: string; documents: number }[];
}

/** What your documents' metadata holds, counted from them as they are now: nothing is declared or enforced. */
export interface Schema {
  object: "schema";
  collection_id: string | null;
  documents: number;
  /** Most documents first. */
  keys: SchemaKey[];
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
    super(message);
    this.name = "PageSearchError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
  }
}

type Request = <T>(
  method: string,
  path: string,
  options?: {
    query?: Record<string, string | number | undefined>;
    body?: FormData;
    json?: unknown;
    headers?: Record<string, string>;
  },
) => Promise<T>;

/** One page of a list, newest first. */
export interface ListPage<T> {
  data: T[];
  has_more: boolean;
  /** The page after this one, or null at the end. */
  nextPage(): Promise<ListPage<T> | null>;
}

/** One page of your documents, newest first. */
export type DocumentPage = ListPage<Document>;
/** One page of your collections, newest first. */
export type CollectionPage = ListPage<Collection>;

/**
 * What a list() returns: await it for one page, or loop over it with for await to see every item, the pages after
 * the first fetched as they are needed.
 */
export class Paged<T extends { id: string }> implements PromiseLike<ListPage<T>>, AsyncIterable<T> {
  private first?: Promise<ListPage<T>>;

  constructor(private readonly load: (after?: string) => Promise<{ data: T[]; has_more: boolean }>,
              private readonly after?: string) {}

  then<A = ListPage<T>, B = never>(
    resolved?: ((page: ListPage<T>) => A | PromiseLike<A>) | null, rejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return (this.first ??= this.page(this.after)).then(resolved, rejected);
  }

  catch<B = never>(rejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<ListPage<T> | B> {
    return this.then(undefined, rejected);
  }

  finally(done?: (() => void) | null): Promise<ListPage<T>> {
    return this.then().finally(done);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (let page: ListPage<T> | null = await this; page; page = await page.nextPage()) yield* page.data;
  }

  private async page(after?: string): Promise<ListPage<T>> {
    const { data, has_more } = await this.load(after);
    const last = data[data.length - 1];
    return { data, has_more, nextPage: () => (has_more && last ? this.page(last.id) : Promise.resolve(null)) };
  }
}

/** What documents.list() returns; see Paged. */
export class DocumentList extends Paged<Document> {}
/** What collections.list() returns; see Paged. */
export class CollectionList extends Paged<Collection> {}

/**
 * Your documents: client.documents.upload(file), .get(id), .list(), .delete(document), and .search(questions) to
 * find which of them answer a question.
 */
export class Documents {
  constructor(private readonly request: Request) {}

  /**
   * Uploads a PDF: a path (in Node) or its bytes. Uploading the same file again returns its document. With
   * collection, the document is put in that collection too; metadata is set on it, as update() does.
   *
   * With wait (the default), resolves once the document is ready to search, or rejects if it failed; most are
   * ready in a second or two. Without it, resolves at once; the document may still be processing.
   */
  async upload(
    file: FileInput,
    options: { filename?: string; collection?: Collection | string; metadata?: Metadata; wait?: boolean; timeout?: number } = {},
  ): Promise<Document> {
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
    if (options.collection !== undefined) form.append("collection_id", id(options.collection));
    if (options.metadata !== undefined) form.append("metadata", JSON.stringify(options.metadata));
    const doc = await this.request<Document>("POST", "/documents", { body: form });
    return options.wait === false ? doc : this.wait(doc, { timeout: options.timeout });
  }

  /** The document once it is ready; rejects if it failed or is not ready within timeout (milliseconds). */
  async wait(document: Document | string, options: { timeout?: number; interval?: number } = {}): Promise<Document> {
    let doc = typeof document === "string" ? await this.get(document) : document;
    const deadline = Date.now() + (options.timeout ?? 300_000);
    while (doc.status === "processing") {
      if (Date.now() > deadline) throw new PageSearchError(`Document ${doc.id} is still processing.`);
      await sleep(options.interval ?? 1000);
      doc = await this.get(doc.id);
    }
    if (doc.status === "failed") {
      throw new PageSearchError(doc.error || `Document ${doc.id} could not be processed.`, { code: "document_failed" });
    }
    return doc;
  }

  get(documentId: string): Promise<Document> {
    return this.request<Document>("GET", `/documents/${encodeURIComponent(documentId)}`);
  }

  /** Sets metadata keys; a key set to null is removed, and keys not named stay. */
  update(document: Document | string, changes: { metadata: Record<string, string | number | boolean | null> }): Promise<Document> {
    return this.request<Document>("PATCH", `/documents/${encodeURIComponent(id(document))}`, { json: changes });
  }

  /**
   * Your documents, newest first, or those in a collection, or whose metadata meets filter; limit (1 to 100) a page;
   * after: the last id of the page before.
   *
   *     for await (const doc of client.documents.list()) ...   // every document, a page at a time
   *     const page = await client.documents.list({ limit: 10 }); // one page: page.data, page.has_more
   */
  list(options: { limit?: number; after?: string; collection?: Collection | string; filter?: Filter } = {}): DocumentList {
    const limit = options.limit ?? 20;
    const collection_id = options.collection === undefined ? undefined : id(options.collection);
    const filter = options.filter === undefined ? undefined : JSON.stringify(options.filter);
    return new DocumentList(
      (after) => this.request<{ data: Document[]; has_more: boolean }>(
        "GET", "/documents", { query: { limit, after, collection_id, filter } }),
      options.after,
    );
  }

  /**
   * The metadata keys of your documents, or of those in a collection, or meeting filter: each key's types, how many
   * documents have it, its least and greatest numbers, and its commonest strings.
   */
  schema(options: { collection?: Collection | string; filter?: Filter } = {}): Promise<Schema> {
    const collection_id = options.collection === undefined ? undefined : id(options.collection);
    const filter = options.filter === undefined ? undefined : JSON.stringify(options.filter);
    return this.request<Schema>("GET", "/documents/schema", { query: { collection_id, filter } });
  }

  /** Deletes a document and its pages; searches of it then fail. */
  async delete(document: Document | string): Promise<void> {
    await this.request("DELETE", `/documents/${encodeURIComponent(id(document))}`);
  }

  /**
   * Asks up to 10 questions of your documents. For each, the documents likely to hold the answer, most relevant
   * first; then search those documents' pages with client.search().
   *
   * Every document of yours (up to 1,000), only those in documentIds, or only those in a collection and those whose
   * metadata meets filter. Without topK, each answer lists the
   * documents likely to help, possibly none; with it, exactly topK. Each document is priced as a page. Retries
   * send the same idempotencyKey, as client.search() does.
   */
  search(
    questions: string | string[],
    options: {
      documentIds?: (Document | string)[]; collection?: Collection | string; filter?: Filter; topK?: number;
      idempotencyKey?: string;
    } = {},
  ): Promise<DocumentSearchResult> {
    const body: Record<string, unknown> = { questions: typeof questions === "string" ? [questions] : questions };
    if (options.documentIds !== undefined) body.document_ids = options.documentIds.map(id);
    if (options.collection !== undefined) body.collection_id = id(options.collection);
    if (options.filter !== undefined) body.filter = options.filter;
    if (options.topK !== undefined) body.top_k = options.topK;
    return this.request<DocumentSearchResult>("POST", "/documents/search", {
      json: body,
      headers: { "Idempotency-Key": options.idempotencyKey ?? newKey() },
    });
  }
}

/**
 * Named groups of your documents, to search within: client.collections.create(name), .list(), .get(id),
 * .rename(collection, name), .delete(collection), .add(collection, documents), .remove(collection, document). A document
 * may be in many collections; deleting a collection leaves its documents.
 */
export class Collections {
  constructor(private readonly request: Request) {}

  create(name: string): Promise<Collection> {
    return this.request<Collection>("POST", "/collections", { json: { name } });
  }

  /** Your collections, newest first, limit (1 to 100) a page. for await over it for every collection. */
  list(options: { limit?: number; after?: string } = {}): CollectionList {
    const limit = options.limit ?? 20;
    return new CollectionList(
      (after) => this.request<{ data: Collection[]; has_more: boolean }>("GET", "/collections", { query: { limit, after } }),
      options.after,
    );
  }

  get(collectionId: string): Promise<Collection> {
    return this.request<Collection>("GET", `/collections/${encodeURIComponent(collectionId)}`);
  }

  rename(collection: Collection | string, name: string): Promise<Collection> {
    return this.request<Collection>("PATCH", `/collections/${encodeURIComponent(id(collection))}`, { json: { name } });
  }

  /** The metadata keys of the collection's documents: see documents.schema. */
  schema(collection: Collection | string): Promise<Schema> {
    return this.request<Schema>("GET", `/collections/${encodeURIComponent(id(collection))}/schema`);
  }

  /** Deletes the collection; its documents stay. */
  async delete(collection: Collection | string): Promise<void> {
    await this.request("DELETE", `/collections/${encodeURIComponent(id(collection))}`);
  }

  /** Puts documents in the collection (up to 1,000 at once); those already in it stay. */
  add(collection: Collection | string, documents: (Document | string)[]): Promise<Collection> {
    return this.request<Collection>("POST", `/collections/${encodeURIComponent(id(collection))}/documents`, {
      json: { document_ids: documents.map(id) },
    });
  }

  /** Takes a document out of the collection; the document stays. */
  remove(collection: Collection | string, document: Document | string): Promise<Collection> {
    return this.request<Collection>(
      "DELETE", `/collections/${encodeURIComponent(id(collection))}/documents/${encodeURIComponent(id(document))}`);
  }
}

/**
 * A client for the Page Search API.
 *
 *     const client = new PageSearch(); // reads PAGEINDEX_SEARCH_API_KEY
 *     const doc = await client.documents.upload("report.pdf");
 *     const result = await client.search(["What was revenue in 2024?"], { document: doc });
 *     for (const answer of result.results) console.log(answer.question, answer.pages.map((p) => p.page));
 */
export class PageSearch {
  readonly baseURL: string;
  readonly maxRetries: number;
  readonly documents: Documents;
  readonly collections: Collections;
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
    this.documents = new Documents((method, path, opts) => this.request(method, path, opts));
    this.collections = new Collections((method, path, opts) => this.request(method, path, opts));
  }

  // The names before 0.2, kept for a while.

  /** @deprecated Use client.documents.upload(). */
  upload(file: FileInput, options?: { filename?: string; wait?: boolean; timeout?: number }): Promise<Document> {
    renamed("client.upload()", "client.documents.upload()");
    return this.documents.upload(file, options);
  }

  /** @deprecated Use client.documents.wait(). */
  wait(document: Document | string, options?: { timeout?: number; interval?: number }): Promise<Document> {
    renamed("client.wait()", "client.documents.wait()");
    return this.documents.wait(document, options);
  }

  /** @deprecated Use client.documents.get(). */
  document(documentId: string): Promise<Document> {
    renamed("client.document()", "client.documents.get()");
    return this.documents.get(documentId);
  }

  /** @deprecated Use client.documents.list(), and loop over it. */
  iterDocuments(): AsyncIterable<Document> {
    renamed("client.iterDocuments()", "client.documents.list()");
    return this.documents.list({ limit: 100 });
  }

  /** @deprecated Use client.documents.delete(). */
  delete(document: Document | string): Promise<void> {
    renamed("client.delete()", "client.documents.delete()");
    return this.documents.delete(document);
  }

  // Search

  /**
   * Asks up to 10 questions. For each, the pages that help answer it, under the documents they are in.
   *
   *     client.search(questions, { document })     // one document's pages
   *     client.search(questions, { collection })   // across documents: these (documentIds), a collection's, those
   *     client.search(questions)                   // whose metadata meets filter, or all of yours
   *
   * Across documents, the most relevant documents for each question are found first and only their pages searched:
   * those likely to answer, at most maxDocuments (default 3), or exactly documentTopK. Without topK, each document lists the pages likely to help, possibly none; with it,
   * exactly topK. Retries send the same idempotencyKey (a new one by default), so a search retried after a timeout is
   * not run or charged twice; pass your own to make your own retries safe too.
   */
  search(
    questions: string | string[],
    options: {
      document?: Document | string; documentIds?: (Document | string)[]; collection?: Collection | string; filter?: Filter;
      maxDocuments?: number; documentTopK?: number; topK?: number; idempotencyKey?: string;
    } = {},
  ): Promise<SearchResult> {
    if (typeof options === "string" || Array.isArray(options) || (typeof questions === "object" && !Array.isArray(questions))) {
      throw new TypeError("client.search(document, questions) is now client.search(questions, { document })");
    }
    const body: Record<string, unknown> = { questions: typeof questions === "string" ? [questions] : questions };
    if (options.document !== undefined) body.document_id = id(options.document);
    if (options.documentIds !== undefined) body.document_ids = options.documentIds.map(id);
    if (options.collection !== undefined) body.collection_id = id(options.collection);
    if (options.filter !== undefined) body.filter = options.filter;
    if (options.maxDocuments !== undefined) body.max_documents = options.maxDocuments;
    if (options.documentTopK !== undefined) body.document_top_k = options.documentTopK;
    if (options.topK !== undefined) body.top_k = options.topK;
    return this.request<SearchResult>("POST", "/search", {
      json: body,
      headers: { "Idempotency-Key": options.idempotencyKey ?? newKey() },
    });
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
    options: {
      query?: Record<string, string | number | undefined>; json?: unknown; body?: FormData; headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const url = new URL(this.baseURL + path);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": `pageindex-search-js/${VERSION}`,
      ...options.headers,
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

function id(item: Document | Collection | string): string {
  return typeof item === "string" ? item : item.id;
}

/** A random idempotency key; Node 18 has no global crypto. */
function newKey(): string {
  const random = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  if (random) return random.call(globalThis.crypto);
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("");
}

const warned = new Set<string>();

function renamed(old: string, now: string): void {
  if (warned.has(old)) return;
  warned.add(old);
  console.warn(`@pageindex/search: ${old} is now ${now}; the old name goes in a later version.`);
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
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const doc = data as Partial<Document> | undefined;
  if (doc?.object === "document" && doc.status === "failed") {
    // An upload whose file could not be read answers with the document, failed, and why.
    throw new PageSearchError(doc.error || `Document ${doc.id} could not be read.`, {
      status: response.status, code: "document_failed", requestId,
    });
  }
  const found = (data as { error?: unknown } | undefined)?.error;
  const error = found && typeof found === "object" ? (found as { message?: string; code?: string; request_id?: string }) : {};
  throw new PageSearchError(error.message || text.slice(0, 200) || response.statusText, {
    status: response.status,
    code: error.code,
    requestId: error.request_id ?? requestId,
  });
}

export default PageSearch;
