import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-test-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { Store, resolveAsset } = await import("../src/state.js");
const { canonicalTarget, localUrl, targetKey } = await import("../src/paths.js");

function page(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body);
  return file;
}

test("openPage records the agent's version as the revert target", () => {
  const store = new Store();
  const file = page("a.html", "<h1>v1</h1>");
  const opened = store.openPage(file, "<h1>v1</h1>");
  assert.equal(opened.pristine, "<h1>v1</h1>");
  assert.deepEqual(opened.comments, []);
  assert.equal(store.pageForFile(file).key, opened.key);
});

test("reopening a page keeps its comments", () => {
  const store = new Store();
  const file = page("b.html", "<h1>v1</h1>");
  const { key } = store.openPage(file, "<h1>v1</h1>");
  store.addComment(key, { id: "c1", kind: "selection", quote: "v1", feedback: "tighten" });

  const reloaded = new Store();
  assert.equal(reloaded.page(key).comments.length, 1);
  assert.equal(reloaded.page(key).comments[0].feedback, "tighten");
});

test("edits dedupe on label and kind", () => {
  const store = new Store();
  const { key } = store.openPage(page("c.html", "<p>x</p>"), "<p>x</p>");
  store.addEdit(key, "Problem body", "edited");
  store.addEdit(key, "Problem body", "edited");
  store.addEdit(key, "Problem body", "deleted");
  assert.equal(store.page(key).edits.length, 2);
});

test("an agent rewrite becomes the new pristine and clears edits", () => {
  const store = new Store();
  const { key } = store.openPage(page("d.html", "<p>v1</p>"), "<p>v1</p>");
  store.addEdit(key, "Body", "edited");
  store.setPristine(key, "<p>v2</p>");
  assert.equal(store.page(key).pristine, "<p>v2</p>");
  assert.deepEqual(store.page(key).edits, []);
});

test("clearSent removes only the delivered comments", () => {
  const store = new Store();
  const { key } = store.openPage(page("e.html", "<p>x</p>"), "<p>x</p>");
  store.addComment(key, { id: "c1", feedback: "one" });
  store.addComment(key, { id: "c2", feedback: "two" });
  store.addEdit(key, "Body", "edited");
  store.clearSent(key, ["c1"]);
  assert.deepEqual(store.page(key).comments.map((c) => c.id), ["c2"]);
  assert.deepEqual(store.page(key).edits, []);
});

test("last sent review survives acknowledgement and a store restart", () => {
  const store = new Store();
  const { key } = store.openPage(page("review-history.html", "<p>x</p>"), "<p>x</p>");
  const review = {
    comments: [{ id: "c1", kind: "selection", quote: "x", feedback: "Make this clearer." }],
    edits: [{ label: "Body", kind: "edited", before: "x", after: "clearer" }],
    overall_note: "Keep the tone concise.",
    sent_at: "2026-08-26T00:00:00.000Z",
  };
  store.addComment(key, review.comments[0]);
  store.addEdit(key, "Body", "edited", "x", "clearer");
  store.setLastReview(key, review);
  store.clearSent(key, ["c1"], Date.now() + 1);

  assert.deepEqual(store.page(key).comments, []);
  assert.deepEqual(store.page(key).edits, []);
  assert.deepEqual(store.page(key).lastReview, review);
  assert.deepEqual(new Store().page(key).lastReview, review, "history remains durable after restart");
});

test("pages are independent of one another", () => {
  const store = new Store();
  const a = store.openPage(page("p1.html", "<p>a</p>"), "<p>a</p>");
  const b = store.openPage(page("p2.html", "<p>b</p>"), "<p>b</p>");
  store.addComment(a.key, { id: "x", feedback: "on a" });
  assert.equal(store.page(a.key).comments.length, 1);
  assert.equal(store.page(b.key).comments.length, 0);
});

test("localhost targets are canonical, durable, and distinct from files", () => {
  assert.equal(localUrl("http://localhost:3000/wiki#section"), "http://localhost:3000/wiki");
  assert.deepEqual(canonicalTarget("http://127.0.0.1:4000/plan"), {
    kind: "url",
    value: "http://127.0.0.1:4000/plan",
  });
  assert.throws(() => localUrl("https://example.com/wiki"), /limited to localhost/);

  const store = new Store();
  const opened = store.openUrl("http://localhost:3000/wiki#ignored");
  assert.equal(opened.kind, "url");
  assert.equal(opened.url, "http://localhost:3000/wiki");
  assert.equal(opened.key, targetKey(opened.url));
  assert.equal(store.pageForTarget(opened.url).key, opened.key);

  const reloaded = new Store();
  assert.equal(reloaded.page(opened.key).url, opened.url, "URL pages survive without a backing file");
});

test("stale pages and pages whose file vanished are pruned on load", () => {
  const store = new Store();
  const keepFile = page("keep.html", "<p>keep</p>");
  const staleFile = page("stale.html", "<p>stale</p>");
  const goneFile = page("gone.html", "<p>gone</p>");
  const keep = store.openPage(keepFile, "<p>keep</p>");
  const stale = store.openPage(staleFile, "<p>stale</p>");
  const gone = store.openPage(goneFile, "<p>gone</p>");

  store.data.pages[stale.key].updatedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(statePathFor(), JSON.stringify(store.data, null, 2));
  fs.rmSync(goneFile);

  const reloaded = new Store();
  assert.ok(reloaded.page(keep.key), "recent page with a live file survives");
  assert.equal(reloaded.page(stale.key), null, "month-old page is pruned");
  assert.equal(reloaded.page(gone.key), null, "page whose file vanished is pruned");
});

function statePathFor() {
  return path.join(process.env.HUMAN_REVIEW_STATE_DIR, "state.json");
}

test("sent batches persist across a restart, and an ack stays acked", () => {
  const store = new Store();
  const { key } = store.openPage(page("batch.html", "<p>x</p>"), "<p>x</p>");
  store.setBatch(key, { batch: { status: "feedback", pages: [] }, cleanup: [] });

  const restarted = new Store();
  assert.ok(restarted.batch(key), "an unacked batch survives a restart");

  restarted.clearBatch(key);
  restarted.save();
  const again = new Store();
  assert.equal(again.batch(key), null, "an acked batch is not resurrected by a later save");
});

test("resolveAsset refuses to escape the artifact's directory", () => {
  const file = path.join(tmp, "dir", "index.html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "<p>x</p>");
  assert.equal(resolveAsset(file, "style.css"), path.join(tmp, "dir", "style.css"));
  assert.equal(resolveAsset(file, "nested/app.js"), path.join(tmp, "dir", "nested", "app.js"));
  assert.equal(resolveAsset(file, "../secret.txt"), null);
  assert.equal(resolveAsset(file, "../../etc/passwd"), null);
  assert.equal(resolveAsset(file, "%zz"), null, "malformed percent-encoding is a miss, not a crash");
});

test(
  "resolveAsset refuses a symlink that points outside the directory",
  { skip: process.platform === "win32" ? "symlink creation needs privileges on Windows" : false },
  () => {
    const dir = path.join(tmp, "symdir");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, "<p>x</p>");
    const secret = path.join(tmp, "outside-secret.txt");
    fs.writeFileSync(secret, "top secret");
    fs.symlinkSync(secret, path.join(dir, "leak.txt"));
    assert.equal(resolveAsset(file, "leak.txt"), null);

    // A regular sibling still resolves (to its real path).
    fs.writeFileSync(path.join(dir, "style.css"), "body{}");
    assert.equal(resolveAsset(file, "style.css"), fs.realpathSync(path.join(dir, "style.css")));
  }
);

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
