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
  const doc = await client.documents.upload(PDF);
  assert.ok(doc.status === "ready" && doc.pages);
  assert.equal((await client.documents.upload(PDF)).id, doc.id); // the same file is the same document

  const result = await client.search(["What is this document about?", "Who wrote it?"], { document: doc, topK: 3 });
  assert.deepEqual(result.results.map((a) => a.question), ["What is this document about?", "Who wrote it?"]);
  assert.ok(result.results.every((a) => a.documents.length === 1 && a.documents[0].pages.length === 3));
  const pages = result.results[0].documents[0].pages;
  assert.ok(pages.every((p) => p.page >= 1 && p.page <= doc.pages && p.relevance >= 0 && p.relevance <= 1));
  assert.deepEqual(pages, [...pages].sort((a, b) => b.relevance - a.relevance));
  assert.equal(result.usage.pages, doc.pages);

  assert.ok((await client.documents.list({ limit: 100 })).data.some((d) => d.id === doc.id));
  assert.ok("balance_usd" in (await client.usage()));
});

test("errors", { skip }, async () => {
  const client = new PageSearch();
  await assert.rejects(client.documents.get("doc_does_not_exist"), { status: 404, code: "document_not_found" });
  await assert.rejects(async () => await new PageSearch({ apiKey: "pis_live_wrong" }).documents.list(), (error) => {
    assert.ok(error instanceof PageSearchError);
    assert.equal(error.status, 401);
    return true;
  });
});
