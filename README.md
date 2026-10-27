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
const result = await client.search(doc, [
  "What was total revenue in fiscal 2026?",
  "How much stock did NVIDIA buy back?",
]);

for (const answer of result.results) {
  console.log(answer.question);
  for (const page of answer.pages) console.log(`  page ${page.page}: ${page.relevance}`);
}

console.log(`cost $${result.usage.cost_usd}, credit left $${result.usage.balance_usd}`);
```

Upload a document once and search it as often as you like; uploading the same file again returns the same
document. Documents are kept until you delete them:

```ts
for await (const doc of client.documents.list()) {  // every document, newest first, a page at a time
  console.log(doc.id, doc.filename, doc.pages);
}

await client.search("doc_60a07bcef3094b68806070f2", ["What was revenue in 2018?"]); // search one again by its id
await client.documents.delete("doc_60a07bcef3094b68806070f2");
```

## Reference

| | |
| --- | --- |
| `new PageSearch({ apiKey, baseURL, timeout, maxRetries })` | The key defaults to `PAGEINDEX_SEARCH_API_KEY`; `timeout` is in milliseconds (default 120,000). |
| `documents.upload(file, { filename, wait })` | A path, or the file's bytes (`Uint8Array`, `ArrayBuffer`, `Blob`). Resolves to a `Document`, ready to search unless `wait: false`. |
| `search(document, questions, { topK, idempotencyKey })` | Up to 10 questions. Each answer lists the pages likely to help (possibly none), or exactly `topK`. A search retried after a timeout is not charged twice. |
| `documents.list({ limit, after })` | Your documents, newest first. `for await` over it for every document; `await` it for one page (`data`, `has_more`). |
| `documents.get(id)`, `documents.delete(document)` | One document; delete one. |
| `usage({ start, end })` | Uploads, searches and cost by day, your credit and stored pages. |

Before 0.2 these were `upload()`, `document()`, `documents()`, `iterDocuments()` and `delete()` on the client;
all but `documents()` still work, with a warning, for now.

Errors reject with `PageSearchError`, with the API's `status`, `code`, `message` and `requestId`.

See the [API reference](https://search.pageindex.ai/docs/api) for every field and the
[pricing](https://search.pageindex.ai/pricing).
