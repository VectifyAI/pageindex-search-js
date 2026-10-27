// Against the live API, with a real key and a real PDF; skipped without them.
//
//     PAGEINDEX_SEARCH_API_KEY=pis_live_... PAGE_SEARCH_TEST_PDF=report.pdf npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { PageSearch, PageSearchError } from "../dist/esm/index.js";

const PDF = process.env.PAGE_SEARCH_TEST_PDF;
const skip = !(PDF && process.env.PAGEINDEX_SEARCH_API_KEY) && "needs a key and a PDF";

test("upload, search and usage", { skip }, async () => {
  const client = new PageSearch();
  const doc = await client.upload(PDF);
  assert.ok(doc.status === "ready" && doc.pages);
  assert.equal((await client.upload(PDF)).id, doc.id); // the same file is the same document

  const result = await client.search(doc, ["What is this document about?", "Who wrote it?"], { topK: 3 });
  assert.deepEqual(result.results.map((a) => a.question), ["What is this document about?", "Who wrote it?"]);
  assert.ok(result.results.every((a) => a.pages.length === 3));
  const pages = result.results[0].pages;
  assert.ok(pages.every((p) => p.page >= 1 && p.page <= doc.pages && p.relevance >= 0 && p.relevance <= 1));
  assert.deepEqual(pages, [...pages].sort((a, b) => b.relevance - a.relevance));
  assert.equal(result.usage.billable_pages + result.failed_pages.length, doc.pages);

  assert.ok((await client.documents({ limit: 100 })).some((d) => d.id === doc.id));
  assert.ok("balance_usd" in (await client.usage()));
});

test("errors", { skip }, async () => {
  const client = new PageSearch();
  await assert.rejects(client.document("doc_does_not_exist"), { status: 404, code: "document_not_found" });
  await assert.rejects(new PageSearch({ apiKey: "pis_live_wrong" }).documents(), (error) => {
    assert.ok(error instanceof PageSearchError);
    assert.equal(error.status, 401);
    return true;
  });
});
