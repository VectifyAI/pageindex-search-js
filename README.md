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

const doc = await client.upload("NVDA_2026_10K.pdf");
const result = await client.search(doc, [
  "What was total revenue in fiscal 2026?",
  "How much stock did NVIDIA buy back?",
]);

for (const answer of result.results) {
  console.log(answer.question);
  for (const page of answer.pages) console.log(`  page ${page.page}: ${page.relevance.toFixed(2)}`);
}

console.log(`cost $${result.usage.cost_usd}, credit left $${result.usage.balance_usd}`);
```

Upload a document once and search it as often as you like; uploading the same file again returns the same
document.

## Reference

| | |
| --- | --- |
| `new PageSearch({ apiKey, baseURL, timeout, maxRetries })` | The key defaults to `PAGEINDEX_SEARCH_API_KEY`; `timeout` is in milliseconds (default 120,000). |
| `upload(file, { filename, wait })` | A path, or the file's bytes (`Uint8Array`, `ArrayBuffer`, `Blob`). Resolves to a `Document`, ready to search unless `wait: false`. |
| `search(document, questions, { topK })` | Up to 10 questions. Each answer lists the pages likely to help (relevance 0.3 or more; 0.2 or more when fewer than 3 are; possibly none), or exactly `topK`. |
| `document(id)`, `documents({ limit, after })`, `iterDocuments()` | Your documents. |
| `delete(document)` | Delete a document. |
| `usage({ start, end })` | Uploads, searches and cost by day, your credit and stored pages. |

Errors reject with `PageSearchError`, with the API's `status`, `code`, `message` and `requestId`.

See the [API reference](https://search.pageindex.ai/docs/api) for every field and the
[pricing](https://search.pageindex.ai/pricing).
