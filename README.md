# @pageindex/search

JavaScript client for [Page Search API](https://search.pageindex.ai) by PageIndex. Upload a PDF, ask up to 10
questions at once, and get back the pages that answer each one, ranked by relevance. Every page is read.

```bash
npm install @pageindex/search
```

Create an API key in the [console](https://search.pageindex.ai/console/keys) and set it:

```bash
export PAGEINDEX_SEARCH_API_KEY=pis_live_...
```

Node 18 or later. Keep the key on your server: don't ship it to a browser.

## Quick start

```ts
import { PageSearch } from "@pageindex/search";

const client = new PageSearch();

const doc = await client.documents.upload("NVDA_2026_10K.pdf");
const result = await client.search([
  "What was total revenue in fiscal 2026?",
  "How much stock did NVIDIA buy back?",
], { document: doc });

for (const answer of result.results) {
  console.log(answer.question);
  for (const page of answer.documents[0].pages) console.log(`  page ${page.page}: ${page.relevance}`);
}

console.log(`cost $${result.usage.cost_usd}, credit left $${result.usage.balance_usd}`);
```

Upload a document once and search it as often as you like; uploading the same file again returns the same
document. Documents are kept until you delete them:

```ts
for await (const doc of client.documents.list()) {  // every document, newest first, a page at a time
  console.log(doc.id, doc.filename, doc.pages);
}

await client.search(["What was revenue in 2018?"], { document: "doc_60a07bcef3094b68806070f2" }); // search one again by its id
await client.documents.delete("doc_60a07bcef3094b68806070f2");
```

With many documents, search across them: the documents likely to answer are found first, then their pages.

```js
const result = await client.search("What was capital expenditure in 2018?"); // every document of yours
for (const doc of result.results[0].documents) {
  console.log(doc.filename, doc.pages.map((p) => [p.page, p.relevance]));
}
```

To find only which documents answer, use `client.documents.search`.

Group documents into collections, and search within one:

```js
const reports = await client.collections.create("Annual reports");
await client.documents.upload("3M_2018_10K.pdf", { collection: reports }); // or later: client.collections.add(reports, [doc])
const result = await client.search("What was capital expenditure in 2018?", { collection: reports });
```

A document may be in many collections; deleting a collection leaves its documents.

Give documents your own metadata (strings, numbers and booleans) and filter by it:

```js
const doc = await client.documents.upload("3M_2018_10K.pdf", { metadata: { ticker: "MMM", year: 2018 } });
await client.documents.update(doc, { metadata: { audited: true } }); // null removes a key
const recent = await client.documents.list({ filter: { year: { $gte: 2020 } } });
const result = await client.search("Who is the CEO?", { filter: { ticker: { $in: ["MMM", "AAPL"] } } });
```

Filters take `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$and` and `$or`.

Read pages: their text, or a page as a picture. Each page a search lists says how it is best read (`page.read`:
`"text"`, or `"image"` for a scan or a chart, whose text may be incomplete); `includeText: true` lists it with its
text.

```js
const texts = await client.documents.pages(doc, [38, 39]); // each with .text and .read
const png = await client.documents.pageImage(doc, 38);     // PNG bytes
const part = await client.documents.pageImage(doc, 38, { box: [0, 0.3, 1, 0.6] }); // a band of it, sharper
```

## Agents

`client.tools()` gives an LLM agent six tools over your documents: `list_documents` (free: documents whose metadata
meets a filter, with your metadata's keys and values in its description, so the agent can write filters),
`search_documents` (which documents answer a question, for when a filter cannot pick them), `search_pages` (with each
page's text),
`read_pages` (text, with a picture of any page that is one), `view_pages` (pages as pictures) and `zoom_page`
(part of a page, sharper, for small print).

```js
const tools = await client.tools({ collection: reports }); // or { filter }, or neither for all your documents

const response = await anthropic.messages.create({ model, tools: tools.definitions, messages });
for (const block of response.content) {
  if (block.type === "tool_use") {
    const content = (await tools.run(block.name, block.input)).anthropic(); // the tool_result content
  }
}
```

For OpenAI, pass `tools.openai`; `tools.run()` gives `.text` and `.images`, each image with `.dataUrl`.

## Reference

| | |
| --- | --- |
| `new PageSearch({ apiKey, baseURL, timeout, maxRetries })` | The key defaults to `PAGEINDEX_SEARCH_API_KEY`; `timeout` is in milliseconds (default 120,000). |
| `documents.upload(file, { filename, collection, metadata, wait })` | A path, or the file's bytes (`Uint8Array`, `ArrayBuffer`, `Blob`). Resolves to a `Document`, ready to search unless `wait: false`. |
| `search(questions, { document, documentIds, collection, filter, maxDocuments, documentTopK, topK, includeText, idempotencyKey })` | Up to 10 questions. For each, the pages that help, under the documents they are in: of one document, or across documents (those named, a collection's, those meeting `filter`, or all), whose most relevant are opened: those likely to answer, at most `maxDocuments` (default 3), or exactly `documentTopK`. Each document lists the pages likely to help, or exactly `topK`, each with how it is best read, and with `includeText`, its text; without `topK`, `more_pages` lists the next most relevant, without text. A search retried after a timeout is not charged twice. |
| `documents.search(questions, { documentIds, collection, filter, topK, idempotencyKey })` | Up to 10 questions of your documents (all of them, up to 1,000, those named, or a collection's). Each answer lists the documents likely to hold it, or exactly `topK`. Each document is priced at the document search price. |
| `documents.list({ limit, offset, collection, filter })` | Your documents, newest first, or a collection's, or those whose metadata meets `filter`: `limit` of them after the first `offset`. `for await` over it for every document; `await` it for one page (`data`, `has_more`, `total`: how many in all). |
| `documents.get(id)`, `documents.delete(document)` | One document; delete one. |
| `documents.pages(document, pages)`, `documents.pageImage(document, page, { box })` | The text of up to 20 pages, each with how it is best read; a page as PNG bytes, or with `box` ([x0, y0, x1, y1] as fractions of the page from its top left) part of it, sharper. |
| `tools({ collection, filter })` | Tools for an LLM agent: `.definitions` (Anthropic), `.openai`, and `.run(name, input)`. |
| `documents.update(document, { metadata })` | Set metadata keys; `null` removes one. |
| `collections.schema(collection)`, `documents.schema({ collection, filter })` | The metadata keys the documents have: each key's types, how many documents have it, its least and greatest numbers and commonest strings. Counted as they are now; nothing is enforced. |
| `collections.create(name)`, `.list()`, `.get(id)`, `.rename(collection, name)`, `.delete(collection)` | Named groups of your documents. Deleting one leaves its documents. |
| `collections.add(collection, documents)`, `.remove(collection, document)` | Put documents in a collection, or take one out. `documents.upload(file, { collection })` puts a new one in. |
| `usage({ start, end })` | Uploads, searches and cost by day, your credit and stored pages. |

In 0.4, `search(document, questions)` became `search(questions, { document })`, and each answer lists
documents, each with its pages. Before 0.2 these were `upload()`, `document()`, `documents()`, `iterDocuments()` and `delete()` on the client;
all but `documents()` still work, with a warning, for now.

Errors reject with `PageSearchError`, with the API's `status`, `code`, `message` and `requestId`.

See the [API reference](https://search.pageindex.ai/docs/api) for every field and the
[pricing](https://search.pageindex.ai/pricing).
