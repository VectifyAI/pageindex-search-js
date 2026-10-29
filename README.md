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

## Reference

| | |
| --- | --- |
| `new PageSearch({ apiKey, baseURL, timeout, maxRetries })` | The key defaults to `PAGEINDEX_SEARCH_API_KEY`; `timeout` is in milliseconds (default 120,000). |
| `documents.upload(file, { filename, collection, metadata, wait })` | A path, or the file's bytes (`Uint8Array`, `ArrayBuffer`, `Blob`). Resolves to a `Document`, ready to search unless `wait: false`. |
| `search(questions, { document, documentIds, collection, filter, maxDocuments, documentTopK, topK, idempotencyKey })` | Up to 10 questions. For each, the pages that help, under the documents they are in: of one document, or across documents (those named, a collection's, those meeting `filter`, or all), whose most relevant are opened: those likely to answer, at most `maxDocuments` (default 3), or exactly `documentTopK`. Each document lists the pages likely to help, or exactly `topK`. A search retried after a timeout is not charged twice. |
| `documents.search(questions, { documentIds, collection, filter, topK, idempotencyKey })` | Up to 10 questions of your documents (all of them, up to 1,000, those named, or a collection's). Each answer lists the documents likely to hold it, or exactly `topK`. Each document is priced as a page. |
| `documents.list({ limit, after, collection, filter })` | Your documents, newest first, or a collection's, or those whose metadata meets `filter`. `for await` over it for every document; `await` it for one page (`data`, `has_more`). |
| `documents.get(id)`, `documents.delete(document)` | One document; delete one. |
| `documents.update(document, { metadata })` | Set metadata keys; `null` removes one. |
| `collections.create(name)`, `.list()`, `.get(id)`, `.rename(collection, name)`, `.delete(collection)` | Named groups of your documents. Deleting one leaves its documents. |
| `collections.add(collection, documents)`, `.remove(collection, document)` | Put documents in a collection, or take one out. `documents.upload(file, { collection })` puts a new one in. |
| `usage({ start, end })` | Uploads, searches and cost by day, your credit and stored pages. |

In 0.4, `search(document, questions)` became `search(questions, { document })`, and each answer lists
documents, each with its pages. Before 0.2 these were `upload()`, `document()`, `documents()`, `iterDocuments()` and `delete()` on the client;
all but `documents()` still work, with a warning, for now.

Errors reject with `PageSearchError`, with the API's `status`, `code`, `message` and `requestId`.

See the [API reference](https://search.pageindex.ai/docs/api) for every field and the
[pricing](https://search.pageindex.ai/pricing).
