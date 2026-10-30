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
  const doc = await client.documents.upload(new Uint8Array([37, 80, 68, 70]), { filename: "a.pdf" });
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
  await client.documents.upload(new URL(import.meta.url).pathname);
  assert.equal(seen[0].body.get("file").name, "client.test.mjs");
});

test("a failed document rejects", async () => {
  const { fetch } = fake([200, { ...DOC, status: "failed", error: "Not a readable PDF." }]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  await assert.rejects(client.documents.upload(new Uint8Array([1])), { code: "document_failed", message: /Not a readable PDF/ });
});

test("an upload that cannot be read rejects with the document's reason", async () => {
  const { fetch } = fake([422, { ...DOC, status: "failed", pages: null, error: "The PDF could not be read; it may be damaged." }]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  await assert.rejects(client.documents.upload(new Uint8Array([1])), {
    status: 422, code: "document_failed", requestId: "req_x", message: "The PDF could not be read; it may be damaged.",
  });
});

test("search sends the questions and where to look", async () => {
  const found = { document_id: "doc_1", filename: "a.pdf", page_count: 3, metadata: {}, relevance: null,
    pages: [{ page: 2, relevance: 0.9 }], failed_pages: [] };
  const result = { object: "search", id: "srch_1", results: [{ question: "q", documents: [found] }],
    failed_documents: [], processing_documents: [] };
  const { fetch, seen } = fake([200, result], [200, result], [200, result]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  const out = await client.search("q", { document: DOC, topK: 1 });
  assert.equal(seen[0].url, "https://api.search.pageindex.ai/v1/search");
  assert.deepEqual(JSON.parse(seen[0].body), { questions: ["q"], document_id: "doc_1", top_k: 1 });
  assert.equal(out.results[0].documents[0].pages[0].page, 2);
  await client.search(["q1", "q2"], { collection: "col_1", filter: { year: 2026 }, maxDocuments: 2 });
  assert.deepEqual(JSON.parse(seen[1].body),
    { questions: ["q1", "q2"], collection_id: "col_1", filter: { year: 2026 }, max_documents: 2 });
  await client.search("q", { documentTopK: 3 });
  assert.deepEqual(JSON.parse(seen[2].body), { questions: ["q"], document_top_k: 3 });
  // The call before 0.4 says how it reads now.
  assert.throws(() => client.search(DOC, "q"), /\{ document \}/);
});

test("a retried search sends the same idempotency key", async () => {
  const result = { object: "search", id: "srch_1", results: [], failed_documents: [], processing_documents: [] };
  const { fetch, seen } = fake([503, {}], [200, result]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  await client.search("q", { document: "doc_1" });
  const keys = seen.map((r) => r.headers["Idempotency-Key"]);
  assert.equal(keys.length, 2);
  assert.ok(keys[0] && keys[0] === keys[1]);
});

test("documents.list() goes through every page when looped over", async () => {
  const { fetch, seen } = fake(
    [200, { data: [DOC, { ...DOC, id: "doc_2" }], has_more: true }],
    [200, { data: [{ ...DOC, id: "doc_3" }], has_more: false }],
  );
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  const ids = [];
  for await (const doc of client.documents.list({ limit: 2 })) ids.push(doc.id);
  assert.deepEqual(ids, ["doc_1", "doc_2", "doc_3"]);
  assert.match(seen[1].url, /after=doc_2/);
});

test("busy and unreachable are retried; other errors are not", async () => {
  const { fetch, seen } = fake([503, {}], [new TypeError("fetch failed"), null], [200, DOC]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  assert.equal((await client.documents.get("doc_1")).id, "doc_1");
  assert.equal(seen.length, 3);

  const missing = fake([404, { error: { code: "document_not_found", message: "No document doc_9.", request_id: "req_9" } }]);
  const other = new PageSearch({ apiKey: "pis_live_x", fetch: missing.fetch });
  await assert.rejects(other.documents.get("doc_9"), (error) => {
    assert.ok(error instanceof PageSearchError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "document_not_found");
    assert.equal(error.requestId, "req_9");
    return true;
  });
  assert.equal(missing.seen.length, 1);
});

test("documents.list() awaited is one page", async () => {
  const { fetch, seen } = fake([200, { data: [DOC], has_more: true }]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  const page = await client.documents.list({ limit: 1 });
  assert.deepEqual(page.data.map((d) => d.id), ["doc_1"]);
  assert.equal(page.has_more, true);
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /limit=1/);
});

test("the names before 0.2 still work", async () => {
  const { fetch } = fake([200, DOC], [200, { data: [DOC], has_more: false }]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  const warn = console.warn;
  const warned = [];
  console.warn = (message) => warned.push(message);
  try {
    assert.equal((await client.document("doc_1")).id, "doc_1");
    const ids = [];
    for await (const doc of client.iterDocuments()) ids.push(doc.id);
    assert.deepEqual(ids, ["doc_1"]);
  } finally {
    console.warn = warn;
  }
  assert.ok(warned.some((m) => m.includes("documents.get")) && warned.some((m) => m.includes("documents.list")));
});

test("documents.search() sends the questions, the documents named and a key", async () => {
  const found = {
    object: "document_search", id: "srch_1",
    results: [{ question: "Who is the CEO?", documents: [{ document_id: "doc_2", filename: "b.pdf", pages: 40, relevance: 0.9 }] }],
    failed_documents: [], processing_documents: [],
    usage: { documents: 2, questions: 1, billable_documents: 2, cost_usd: 0.001, balance_usd: 4.999 }, seconds: 0.8,
  };
  const { fetch, seen } = fake([200, found]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  const result = await client.documents.search("Who is the CEO?", { documentIds: [DOC, "doc_2"], topK: 1 });
  assert.match(seen[0].url, /\/v1\/documents\/search$/);
  assert.deepEqual(JSON.parse(seen[0].body), { questions: ["Who is the CEO?"], document_ids: ["doc_1", "doc_2"], top_k: 1 });
  assert.ok(seen[0].headers["Idempotency-Key"]);
  assert.equal(result.results[0].documents[0].document_id, "doc_2");
});

test("collections: create, add, remove, and upload, list and search within one", async () => {
  const col = { object: "collection", id: "col_1", name: "Reports", documents: 2, created_at: "2026-10-29T00:00:00Z" };
  const found = { object: "document_search", id: "srch_1", results: [], failed_documents: [], processing_documents: [],
    usage: { documents: 0, questions: 1, billable_documents: 0, cost_usd: 0, balance_usd: 5 }, seconds: 0.1 };
  const { fetch, seen } = fake([200, col], [200, col], [200, col], [200, DOC], [200, { data: [DOC], has_more: false }],
    [200, found], [200, { data: [col], has_more: false }]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  const made = await client.collections.create("Reports");
  assert.equal(made.id, "col_1");
  await client.collections.add(made, [DOC, "doc_2"]);
  await client.collections.remove(made, "doc_2");
  await client.documents.upload(new Uint8Array([37, 80, 68, 70]), { collection: made, wait: false });
  const ids = [];
  for await (const doc of client.documents.list({ collection: "col_1" })) ids.push(doc.id);
  await client.documents.search("q", { collection: made });
  const names = [];
  for await (const c of client.collections.list()) names.push(c.name);

  assert.deepEqual(JSON.parse(seen[0].body), { name: "Reports" });
  assert.match(seen[1].url, /\/collections\/col_1\/documents$/);
  assert.deepEqual(JSON.parse(seen[1].body), { document_ids: ["doc_1", "doc_2"] });
  assert.equal(seen[2].method, "DELETE");
  assert.match(seen[2].url, /\/collections\/col_1\/documents\/doc_2$/);
  assert.equal(seen[3].body.get("collection_id"), "col_1");
  assert.match(seen[4].url, /collection_id=col_1/);
  assert.deepEqual(ids, ["doc_1"]);
  assert.equal(JSON.parse(seen[5].body).collection_id, "col_1");
  assert.deepEqual(names, ["Reports"]);
});

test("metadata: set on upload and update; filter on list and search", async () => {
  const doc = { ...DOC, metadata: { year: 2018 } };
  const found = { object: "document_search", id: "s", results: [], failed_documents: [], processing_documents: [],
    usage: { documents: 0, questions: 1, billable_documents: 0, cost_usd: 0, balance_usd: 5 }, seconds: 0.1 };
  const { fetch, seen } = fake([200, doc], [200, doc], [200, { data: [doc], has_more: false }], [200, found]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  await client.documents.upload(new Uint8Array([37, 80, 68, 70]), { metadata: { year: 2018 }, wait: false });
  await client.documents.update("doc_1", { metadata: { note: null } });
  const page = await client.documents.list({ filter: { year: { $gte: 2015 } } });
  await client.documents.search("q", { filter: { ticker: "MMM" } });
  assert.equal(seen[0].body.get("metadata"), '{"year":2018}');
  assert.equal(seen[1].method, "PATCH");
  assert.deepEqual(JSON.parse(seen[1].body), { metadata: { note: null } });
  assert.deepEqual(JSON.parse(new URL(seen[2].url).searchParams.get("filter")), { year: { $gte: 2015 } });
  assert.deepEqual(page.data[0].metadata, { year: 2018 });
  assert.deepEqual(JSON.parse(seen[3].body).filter, { ticker: "MMM" });
});

test("works from require too", () => {
  const { PageSearch: Required } = createRequire(import.meta.url)("../dist/cjs/index.js");
  assert.equal(typeof Required, "function");
});

test("schema: of a collection, or of documents meeting a filter", async () => {
  const schema = { object: "schema", collection_id: "col_1", documents: 3, keys: [
    { key: "year", types: ["number", "string"], documents: 3, min: 2025, max: 2026, values: [{ value: "2024", documents: 1 }] }] };
  const { fetch, seen } = fake([200, schema], [200, schema]);
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  const s = await client.collections.schema("col_1");
  assert.equal(seen[0].url, "https://api.search.pageindex.ai/v1/collections/col_1/schema");
  assert.deepEqual(s.keys[0].types, ["number", "string"]);
  await client.documents.schema({ filter: { ticker: "NVDA" } });
  const url = new URL(seen[1].url);
  assert.equal(url.pathname, "/v1/documents/schema");
  assert.deepEqual(JSON.parse(url.searchParams.get("filter")), { ticker: "NVDA" });
});

test("tools: schema in the description, searches, and pages with pictures", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    const u = new URL(String(url));
    seen.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : null });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.pathname.endsWith("/schema")) {
      return json({ object: "schema", collection_id: "col_1", documents: 3, keys: [
        { key: "ticker", types: ["string"], documents: 3, values: [{ value: "MMM", documents: 2 }] },
        { key: "year", types: ["number"], documents: 3, min: 2018, max: 2024 }] });
    }
    if (u.pathname.endsWith("/image")) return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
    if (u.pathname.endsWith("/pages")) {
      if (u.searchParams.get("pages") === "99") return json({ error: { code: "invalid_request", message: "There is no page 99." } }, 422);
      return json({ object: "list", data: u.searchParams.get("pages").split(",").map((p) => (
        { object: "page", page: Number(p), read: p === "7" ? "image" : "text", text: `text ${p}` })) });
    }
    if (u.pathname.endsWith("/documents/search")) {
      return json({ object: "document_search", id: "dsrch_1", results: [{ question: "q", documents: [
        { document_id: "doc_1", relevance: 0.9, filename: "a.pdf", pages: 10, metadata: { year: 2018 } }] }],
        failed_documents: [], processing_documents: [] });
    }
    return json({ object: "search", id: "srch_1", results: [{ question: "q", documents: [
      { document_id: "doc_1", filename: "a.pdf", pages: [{ page: 4, relevance: 1, read: "image", text: "Chart" }] }] }],
      failed_documents: [], processing_documents: [] });
  };
  const client = new PageSearch({ apiKey: "pis_live_x", fetch });
  const tools = await client.tools({ collection: "col_1", filter: { audited: true } });
  assert.match(tools.definitions[0].description, /- ticker: string, on 3 documents; values: "MMM" \(2\), and others/);
  assert.match(tools.definitions[0].description, /- year: number, on 3 documents; 2018 to 2024/);
  assert.deepEqual(tools.openai.map((t) => t.function.name), ["search_documents", "search_pages", "read_pages", "view_pages"]);

  let out = JSON.parse((await tools.run("search_documents", { question: "q", filter: { year: 2018 }, top_k: "auto" })).text);
  assert.equal(out.documents[0].document_id, "doc_1");
  assert.deepEqual(seen.at(-1).body, { questions: ["q"], collection_id: "col_1", filter: { $and: [{ audited: true }, { year: 2018 }] } });

  out = JSON.parse((await tools.run("search_pages", { question: "q", document_ids: ["doc_1", "doc_2"] })).text);
  assert.deepEqual(out.documents[0].pages, [{ page: 4, relevance: 1, read: "image", text: "Chart" }]);
  assert.deepEqual(seen.at(-1).body, { questions: ["q"], document_ids: ["doc_1", "doc_2"], document_top_k: 2, include_text: true });
  await tools.run("search_pages", { question: "q", document_ids: ["doc_1"], top_k: 3 });
  assert.deepEqual(seen.at(-1).body, { questions: ["q"], document_id: "doc_1", top_k: 3, include_text: true });

  let result = await tools.run("read_pages", { document_id: "doc_1", pages: [4, 7, 4] });
  assert.deepEqual(JSON.parse(result.text).pages.map((p) => [p.page, p.read]), [[4, "text"], [7, "image"]]);
  assert.deepEqual(result.images.map((i) => i.page), [7]);
  assert.equal(result.images[0].dataUrl, "data:image/png;base64,iVBORw==");
  assert.equal(result.anthropic()[1].text, "Page 7 of doc_1:");
  result = await tools.run("view_pages", { document_id: "doc_1", pages: [4, 9] });
  assert.deepEqual(result.images.map((i) => i.page), [4, 9]);
  assert.deepEqual(JSON.parse((await tools.run("read_pages", { document_id: "doc_1", pages: [99] })).text), { error: "There is no page 99." });
  assert.match((await tools.run("view_pages", { document_id: "doc_1", pages: [1, 2, 3, 4, 5, 6] })).text, /error/);
});
