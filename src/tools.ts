/**
 * Tools an LLM agent can call: list documents by their metadata, find which documents answer, search the pages of the ones it picks (with their
 * text), read pages, with pictures of those best seen, and zoom in on a part of a page too small to read.
 *
 *     const tools = await client.tools({ collection: filings });
 *     const response = await anthropic.messages.create({ ..., tools: tools.definitions });
 *     for (const block of response.content) {
 *       if (block.type === "tool_use") content = (await tools.run(block.name, block.input)).anthropic();
 *     }
 */
import type { Collection, Filter, PageSearch, PageText, Schema } from "./index.js";

const MAX_PAGES_READ = 20; // pages one read_pages call may read
const MAX_IMAGES = 5; // pictures one read_pages call may give: each is some thousands of tokens
const MAX_QUESTIONS = 10; // questions one search may ask
const MAX_LISTED = 100; // documents one list_documents call may list

const CORNERS = ["x0", "y0", "x1", "y1"] as const;
/** Part of a page: x0, y0 its top left corner, x1, y1 its bottom right, as fractions of the page from its top left. */
export type Box = Record<(typeof CORNERS)[number], number>;

const BOX = {
  type: "object",
  properties: Object.fromEntries(CORNERS.map((k) => [k, { type: "number", minimum: 0, maximum: 1 }])),
  required: [...CORNERS], additionalProperties: false,
  description: "The part to see, as fractions of the page: x from 0 at its left edge to 1 at its right, y from 0 at " +
    "its top to 1 at its bottom; x0, y0 the top left corner, x1, y1 the bottom right. " +
    '{"x0": 0, "y0": 0.3, "x1": 1, "y1": 0.6} is the band from 30% to 60% of the way down, full width.',
};

const QUESTIONS = {
  type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_QUESTIONS,
  description: "The questions, as a person would ask them: several at once cost much less than one at a time, so ask " +
    "together the questions you have of the same documents.",
};

const FILTERS = 'Conditions: {"key": value} equals; {"key": {"$ne"|"$in"|"$nin"|"$gt"|"$gte"|"$lt"|"$lte": ...}}; ' +
  '{"$and": [...]} and {"$or": [...]} combine filters. Values match exactly, type included: "2018" is not 2018.';

/** A tool as Anthropic's API takes it; tools.openai has the same in OpenAI's function format. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A page as PNG bytes, or, with box, part of it. */
export class PageImage {
  constructor(readonly documentId: string, readonly page: number, readonly png: Uint8Array, readonly box?: Box) {}

  /** What the picture is, to put before it: "Page 7 of doc_...:". */
  get label(): string {
    const box = this.box;
    const part = box ? ", " + CORNERS.map((k) => `${k} ${box[k]}`).join(", ") : "";
    return `Page ${this.page} of ${this.documentId}${part}:`;
  }

  get base64(): string {
    return toBase64(this.png);
  }

  /** For OpenAI: data:image/png;base64,... */
  get dataUrl(): string {
    return "data:image/png;base64," + this.base64;
  }
}

/** What a tool gives back: JSON text, and from read_pages and view_pages, pictures of pages. */
export class ToolResult {
  constructor(readonly text: string, readonly images: PageImage[] = []) {}

  /** The tool_result content for Claude: the text, then each picture after its page number. */
  anthropic(): string | Record<string, unknown>[] {
    if (!this.images.length) return this.text;
    const content: Record<string, unknown>[] = [{ type: "text", text: this.text }];
    for (const image of this.images) {
      content.push({ type: "text", text: image.label });
      content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: image.base64 } });
    }
    return content;
  }
}

/** The metadata keys, their types and values, as a line each, for the agent to write filters from. */
export function describe(schema: Schema): string {
  if (!schema.keys.length) return "The documents have no metadata, so there is nothing to filter on.";
  const lines = [`Metadata keys of the ${schema.documents} documents:`];
  for (const key of schema.keys) {
    let line = `- ${key.key}: ${key.types.join(" or ")}, on ${key.documents} documents`;
    if (key.min !== undefined && key.min !== null) line += `; ${key.min} to ${key.max}`;
    if (key.values?.length) {
      const shown = key.values.map((v) => `${JSON.stringify(v.value)} (${v.documents})`).join(", ");
      const more = key.values.reduce((n, v) => n + v.documents, 0) < key.documents;
      line += `; values: ${shown}` + (more ? ", and others" : "");
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function topK(what: string): Record<string, unknown> {
  return {
    anyOf: [{ type: "string", enum: ["auto"] }, { type: "integer", minimum: 1, maximum: 50 }],
    description: `"auto" (the default, and usually best): the ${what} likely to help. A number: exactly that many, ` +
      "most relevant first, only when auto did not find enough.",
  };
}

/** The questions; one given alone, as models sometimes do, is a list of one. */
function asked(questions: unknown): string[] {
  return Array.isArray(questions) ? questions.map(String) : [String(questions ?? "")];
}

function auto(value: unknown): number | undefined {
  return value === undefined || value === null || value === "auto" ? undefined : Number(value);
}

/**
 * list_documents, search_documents, search_pages, read_pages, view_pages and zoom_page over a scope: a collection, documents whose
 * metadata meets a filter, or all of yours. The metadata schema is read once, when made; make new ones when the documents
 * change.
 */
export class Tools {
  readonly definitions: ToolDefinition[];

  private constructor(
    private readonly client: PageSearch,
    private readonly collection: string | undefined,
    private readonly filter: Filter | undefined,
    readonly schema: Schema,
  ) {
    this.definitions = [
      this.listDocumentsTool(), this.searchDocumentsTool(), this.searchPagesTool(), this.readPagesTool(),
      this.viewPagesTool(), this.zoomPageTool(),
    ];
  }

  static async create(client: PageSearch, options: { collection?: Collection | string; filter?: Filter } = {}): Promise<Tools> {
    const collection = options.collection === undefined ? undefined
      : typeof options.collection === "string" ? options.collection : options.collection.id;
    const schema = collection !== undefined && options.filter === undefined
      ? await client.collections.schema(collection)
      : await client.documents.schema({ collection, filter: options.filter });
    return new Tools(client, collection, options.filter, schema);
  }

  /** The definitions in OpenAI's function format. */
  get openai(): Record<string, unknown>[] {
    return this.definitions.map((d) => ({
      type: "function", function: { name: d.name, description: d.description, parameters: d.input_schema },
    }));
  }

  private listDocumentsTool(): ToolDefinition {
    return {
      name: "list_documents",
      description: `List the documents, of ${this.schema.documents}, whose metadata meets a filter, newest first, each ` +
        "with its id, file name, page count, upload time and metadata, and how many match in all. Free. When the question says which documents it is about in " +
        "terms the metadata holds, find them here and search their pages with search_pages; use search_documents, " +
        "which is priced, only when a filter cannot pick them out: none match, too many do, or the question says only " +
        "what it asks.\n\n" + describe(this.schema) + "\n\n" + FILTERS,
      input_schema: {
        type: "object",
        properties: {
          filter: { type: "object", description: "Only documents whose metadata meets this; without it, all." },
          limit: { type: "integer", minimum: 1, maximum: MAX_LISTED, description: "At most this many documents (20 by default)." },
          offset: { type: "integer", minimum: 0, description: "Skip this many first, for the next page: the offset a list gave back." },
        },
      },
    };
  }

  private searchDocumentsTool(): ToolDefinition {
    return {
      name: "search_documents",
      description: `Find which of ${this.schema.documents} documents likely answer each question, most relevant first, ` +
        "with each one's relevance (0 to 1), page count and metadata; always at least one. Priced by the documents it " +
        "looks at: when a metadata filter alone picks the documents, use list_documents, which is free, and when it " +
        "narrows them, pass it here. Then call search_pages with the documents worth reading. Searching a document's " +
        "pages is priced by its pages, so search the most relevant documents first, and others only when the question " +
        'needs them or those did not answer. Use top_k "auto": it returns the documents likely to help, which is best.',
      input_schema: {
        type: "object",
        properties: {
          questions: QUESTIONS,
          filter: { type: "object", description: "Only documents whose metadata meets this, written as for list_documents." },
          top_k: topK("documents"),
        },
        required: ["questions"],
      },
    };
  }

  private searchPagesTool(): ToolDefinition {
    return {
      name: "search_pages",
      description: "Find the pages of one document that help answer each question, most relevant first, each with its " +
        "relevance (0 to 1) and text. Pages are numbered from 1. It is priced by the document's pages: search the " +
        "documents search_documents ranks most relevant first, calling it for each at the same time, and others only " +
        "when needed; to ask again in other words, ask only of the documents still missing the answer. A page whose read is \"image\" " +
        "is a picture, such as a scan or a chart: its text may be incomplete or empty, so look at it with " +
        'read_pages. Use top_k "auto": it returns the pages likely to help, which is best, and a number brings back ' +
        "many pages of text. The most relevant pages usually hold the answer: once they do, stop searching. If they " +
        "do not, more_pages lists the next most relevant: read those with read_pages, which is free, before " +
        "searching again.",
      input_schema: {
        type: "object",
        properties: {
          questions: QUESTIONS,
          document_id: { type: "string", description: "The document to search, from search_documents." },
          top_k: topK("pages"),
        },
        required: ["questions", "document_id"],
      },
    };
  }

  private readPagesTool(): ToolDefinition {
    return {
      name: "read_pages",
      description: "Read pages of a document, numbered from 1: their text, with a picture of any page whose read is " +
        '"image" (a scan or a chart, whose text may be incomplete). Use it for pages search_pages found that are ' +
        "pictures, or for the pages around one, such as where a table goes on. At most " +
        `${MAX_PAGES_READ} pages at a time, and at most ${MAX_IMAGES} of them pictures: in a scanned document every ` +
        `page is a picture, so read ${MAX_IMAGES} at a time. If a picture's small print or figures are hard to read, ` +
        "zoom in with zoom_page.",
      input_schema: {
        type: "object",
        properties: {
          document_id: { type: "string" },
          pages: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: MAX_PAGES_READ },
        },
        required: ["document_id", "pages"],
      },
    };
  }

  private viewPagesTool(): ToolDefinition {
    return {
      name: "view_pages",
      description: `See pages of a document as pictures, with their text: up to ${MAX_IMAGES} at a time, numbered ` +
        "from 1. Use it where how a page looks matters, such as a table's layout or a chart on a page of text. If " +
        "small print or figures are hard to read, zoom in with zoom_page before answering.",
      input_schema: {
        type: "object",
        properties: {
          document_id: { type: "string" },
          pages: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: MAX_IMAGES },
        },
        required: ["document_id", "pages"],
      },
    };
  }

  private zoomPageTool(): ToolDefinition {
    return {
      name: "zoom_page",
      description: "See part of a page, sharper: for small print, a dense table's figures or a footnote that are hard " +
        "to read in a picture from read_pages or view_pages. Look at the whole page first, then zoom on the part you " +
        "need, a band no taller than about a third of the page. Free, as reading pages is.",
      input_schema: {
        type: "object",
        properties: {
          document_id: { type: "string" },
          page: { type: "integer", minimum: 1 },
          box: BOX,
        },
        required: ["document_id", "page", "box"],
      },
    };
  }

  /**
   * Calls a tool the agent asked for; what to send back as its result. An error comes back as {"error": ...}, for the
   * agent to correct.
   */
  async run(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    if ("question" in input && !("questions" in input)) { // one question, as a model may send it
      const { question, ...rest } = input;
      input = { ...rest, questions: question };
    }
    try {
      if (name === "list_documents") return await this.listDocuments(input);
      if (name === "search_documents") return new ToolResult(JSON.stringify(await this.searchDocuments(input)));
      if (name === "search_pages") return new ToolResult(JSON.stringify(await this.searchPages(input)));
      if (name === "read_pages") return await this.pages(input, MAX_PAGES_READ, (p) => p.read === "image");
      if (name === "view_pages") return await this.pages(input, MAX_IMAGES, () => true);
      if (name === "zoom_page") return await this.zoom(input);
      return failed(`No tool ${name}.`);
    } catch (error) {
      if (error instanceof Error && error.name === "PageSearchError") return failed(error.message);
      throw error;
    }
  }

  private async listDocuments(input: Record<string, unknown>): Promise<ToolResult> {
    const limit = input.limit === undefined || input.limit === null ? 20 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LISTED) {
      return failed(`Bad input for list_documents: limit is 1 to ${MAX_LISTED}.`);
    }
    const offset = input.offset === undefined || input.offset === null ? 0 : Number(input.offset);
    if (!Number.isInteger(offset) || offset < 0) return failed("Bad input for list_documents: offset is 0 or more.");
    const page = await this.client.documents.list({
      limit, offset, collection: this.collection, filter: this.scope(input.filter as Filter | undefined),
    });
    const last = page.offset + page.data.length;
    return new ToolResult(JSON.stringify({
      total: page.total,
      documents: page.data.map((d) => ({
        document_id: d.id, filename: d.filename, pages: d.pages, status: d.status, created_at: d.created_at,
        metadata: d.metadata,
      })),
      ...(page.has_more && page.data.length ? {
        more: `Documents ${page.offset + 1} to ${last} of ${page.total}. Next page: offset ${last}, with the same ` +
          "filter; or narrow the filter.",
      } : {}),
    }));
  }

  /** The filter the agent gave, within the one the tools were made with. */
  private scope(filter: Filter | undefined): Filter | undefined {
    return filter === undefined ? this.filter : this.filter === undefined ? filter : { $and: [this.filter, filter] };
  }

  private async searchDocuments(input: Record<string, unknown>): Promise<unknown> {
    const found = await this.client.documents.search(asked(input.questions), {
      collection: this.collection, filter: this.scope(input.filter as Filter | undefined), topK: auto(input.top_k),
    });
    return {
      results: found.results.map((a) => ({
        question: a.question,
        documents: a.documents.map((d) => ({
          document_id: d.document_id, filename: d.filename, pages: d.pages, relevance: d.relevance, metadata: d.metadata,
        })),
      })),
    };
  }

  private async searchPages(input: Record<string, unknown>): Promise<unknown> {
    const documentId = String(input.document_id ?? "");
    if (!documentId) return { error: "Name the document_id to search." };
    const found = await this.client.search(asked(input.questions), {
      document: documentId, topK: auto(input.top_k), includeText: true,
    });
    const first = found.results[0].documents[0];
    return {
      document_id: first.document_id, filename: first.filename,
      results: found.results.map((a) => {
        const d = a.documents[0];
        return {
          question: a.question,
          pages: d.pages.map((p) => ({ page: p.page, relevance: p.relevance, read: p.read, text: p.text })),
          ...(d.more_pages?.length
            ? { more_pages: d.more_pages.map((p) => ({ page: p.page, relevance: p.relevance, read: p.read })) } : {}),
        };
      }),
    };
  }

  private async zoom(input: Record<string, unknown>): Promise<ToolResult> {
    const documentId = String(input.document_id ?? "");
    const page = Number(input.page);
    const given = input.box;
    const named = given !== null && typeof given === "object" && !Array.isArray(given)
      && Object.keys(given).length === CORNERS.length && CORNERS.every((k) => k in given);
    const box = named ? Object.fromEntries(CORNERS.map((k) => [k, Number((given as Box)[k])])) as Box : undefined;
    if (!documentId || !Number.isInteger(page) || !box || CORNERS.some((k) => !Number.isFinite(box[k]))) {
      return failed('Name a document_id, a page, and a box: {"x0": ..., "y0": ..., "x1": ..., "y1": ...}, fractions ' +
        "of the page.");
    }
    const png = await this.client.documents.pageImage(documentId, page, { box: CORNERS.map((k) => box[k]) });
    return new ToolResult(JSON.stringify({ document_id: documentId, page, box }),
      [new PageImage(documentId, page, png, box)]);
  }

  /** The pages' text, and pictures of those pictured picks. */
  private async pages(input: Record<string, unknown>, most: number, pictured: (page: PageText) => boolean): Promise<ToolResult> {
    const documentId = String(input.document_id ?? "");
    const named = [...new Set((input.pages as number[] | undefined) ?? [])];
    if (!documentId || named.length < 1 || named.length > most) return failed(`Name a document_id and 1 to ${most} pages.`);
    const texts = await this.client.documents.pages(documentId, named);
    const shown = texts.filter(pictured).map((p) => p.page);
    if (shown.length > MAX_IMAGES) {
      return failed(`Pages ${shown.join(", ")} are pictures; read at most ${MAX_IMAGES} of them at a time.`);
    }
    const pngs = await Promise.all(shown.map((page) => this.client.documents.pageImage(documentId, page)));
    const out = {
      document_id: documentId,
      pages: texts.map((p) => ({
        page: p.page, read: p.read, text: p.text,
        ...(p.read === "image" ? { note: "Its text may be incomplete: see its picture." } : {}),
      })),
    };
    return new ToolResult(JSON.stringify(out), shown.map((page, i) => new PageImage(documentId, page, pngs[i])));
  }
}

function failed(message: string): ToolResult {
  return new ToolResult(JSON.stringify({ error: message }));
}

function toBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
