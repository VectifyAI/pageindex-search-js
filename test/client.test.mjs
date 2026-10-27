// The client against a stand-in for the API: requests it makes, retries, errors. test/live.test.mjs runs it
// against the real one.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { PageSearch, PageSearchError } from "../dist/esm/index.js";

const DOC = { object: "document", id: "doc_1", status: "ready", filename: "a.pdf", pages: 3, bytes: 10, created_at: "2026-10-27T00:00:00Z" };

/** A fetch that answers from a list of [status, body] in turn, and keeps the requests it saw. */
function fake(...answers) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const [status, body] = answers.shift();
    if (status instanceof Error) throw status;
    return new Response(JSON.stringify(body), { status, headers: { "x-request-id": "req_x" } });
  };
  return { fetch, seen };
}

test("needs a key", () => {
  const saved = process.env.PAGEINDEX_SEARCH_API_KEY;
  delete process.env.PAGEINDEX_SEARCH_API_KEY;
  try {
    assert.throws(() => new PageSearch(), PageSearchError);
  } finally {
    if (saved !== undefined) process.env.PAGEINDEX_SEARCH_API_KEY = saved;
  }
});

test("upload sends the file, then waits for the document", async () => {
  const { fetch, seen } = fake([202, { ...DOC, status: "processing", pages: null }], [200, DOC]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  const doc = await client.upload(new Uint8Array([37, 80, 68, 70]), { filename: "a.pdf" });
  assert.equal(doc.status, "ready");
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "https://api.search.pageindex.ai/v1/documents");
  assert.equal(seen[0].headers.Authorization, "Bearer pis_live_x");
  assert.equal(seen[0].body.get("file").name, "a.pdf");
  assert.equal(seen[1].url, "https://api.search.pageindex.ai/v1/documents/doc_1");
});

test("upload of a path reads the file", async () => {
  const { fetch, seen } = fake([200, DOC]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  await client.upload(new URL(import.meta.url).pathname);
  assert.equal(seen[0].body.get("file").name, "client.test.mjs");
});

test("a failed document rejects", async () => {
  const { fetch } = fake([200, { ...DOC, status: "failed", error: "Not a readable PDF." }]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  await assert.rejects(client.upload(new Uint8Array([1])), { code: "document_failed", message: /Not a readable PDF/ });
});

test("an upload that cannot be read rejects with the document's reason", async () => {
  const { fetch } = fake([422, { ...DOC, status: "failed", pages: null, error: "The PDF could not be read; it may be damaged." }]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  await assert.rejects(client.upload(new Uint8Array([1])), {
    status: 422, code: "document_failed", requestId: "req_x", message: "The PDF could not be read; it may be damaged.",
  });
});

test("search sends the questions and top_k", async () => {
  const result = { object: "search", id: "srch_1", document_id: "doc_1", results: [{ question: "q", pages: [{ page: 2, relevance: 0.9 }] }] };
  const { fetch, seen } = fake([200, result]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  const out = await client.search(DOC, "q", { topK: 1 });
  assert.equal(seen[0].url, "https://api.search.pageindex.ai/v1/documents/doc_1/search");
  assert.deepEqual(JSON.parse(seen[0].body), { questions: ["q"], top_k: 1 });
  assert.equal(out.results[0].pages[0].page, 2);
});

test("iterDocuments follows the pages", async () => {
  const { fetch, seen } = fake(
    [200, { data: [DOC, { ...DOC, id: "doc_2" }], has_more: true }],
    [200, { data: [{ ...DOC, id: "doc_3" }], has_more: false }],
  );
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  const ids = [];
  for await (const doc of client.iterDocuments()) ids.push(doc.id);
  assert.deepEqual(ids, ["doc_1", "doc_2", "doc_3"]);
  assert.match(seen[1].url, /after=doc_2/);
});

test("busy and unreachable are retried; other errors are not", async () => {
  const { fetch, seen } = fake([503, {}], [new TypeError("fetch failed"), null], [200, DOC]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  assert.equal((await client.document("doc_1")).id, "doc_1");
  assert.equal(seen.length, 3);

  const missing = fake([404, { error: { code: "document_not_found", message: "No document doc_9.", request_id: "req_9" } }]);
  const other = new PageSearch({ apiKey: "pis_live_x", fetch: missing.fetch });
  await assert.rejects(other.document("doc_9"), (error) => {
    assert.ok(error instanceof PageSearchError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "document_not_found");
    assert.equal(error.requestId, "req_9");
    return true;
  });
  assert.equal(missing.seen.length, 1);
});

test("works from require too", () => {
  const { PageSearch: Required } = createRequire(import.meta.url)("../dist/cjs/index.js");
  assert.equal(typeof Required, "function");
});
