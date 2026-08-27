import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-markdown-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { start } = await import("../src/server.js");
const { isMarkdown, renderMarkdownPage } = await import("../src/markdown.js");

function request(port, token, { method = "GET", route = "/", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          "x-human-review-token": token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Ack completes before the replacement long-poll writes its first heartbeat. */
function acknowledge(port, token, file) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/poll?file=${encodeURIComponent(file)}&ack=1`,
        headers: { "x-human-review-token": token },
      },
      (res) => {
        res.once("data", () => {
          res.destroy();
          resolve();
        });
      }
    );
    req.on("error", (err) => {
      if (err.code === "ECONNRESET") resolve();
      else reject(err);
    });
    req.end();
  });
}

test("isMarkdown matches only markdown extensions", () => {
  assert.equal(isMarkdown("/a/plan.md"), true);
  assert.equal(isMarkdown("/a/plan.markdown"), true);
  assert.equal(isMarkdown("/a/PLAN.MD"), true);
  assert.equal(isMarkdown("/a/plan.html"), false);
  assert.equal(isMarkdown("/a/plan.md.html"), false);
});

test("renderMarkdownPage produces a full document from gfm source", () => {
  const html = renderMarkdownPage("# Plan\n\nShip **soon**.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n", "/x/plan.md");
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<h1[^>]*>Plan<\/h1>/);
  assert.match(html, /<strong>soon<\/strong>/);
  assert.match(html, /<table>/, "gfm tables render");
  assert.match(html, /<title>plan\.md<\/title>/);
});

test("renderMarkdownPage adds a review-only table of contents for h1-h3", () => {
  const html = renderMarkdownPage(
    "# Runtime Watchdog\n\n## Call Trace\n\n### 数据流\n\n#### Internal detail\n\n## Call Trace\n",
    "/x/design.md"
  );
  const document = new JSDOM(html).window.document;
  const toc = document.querySelector("nav.toc");
  assert.ok(toc, "documents with headings get a table of contents");
  assert.equal(toc.hasAttribute("data-eh-ui"), true, "the review SDK ignores the generated navigation");
  assert.deepEqual(
    [...toc.querySelectorAll("a")].map((element) => ({
      text: element.textContent,
      href: element.getAttribute("href"),
      depth: element.parentElement.className,
    })),
    [
      { text: "Runtime Watchdog", href: "#runtime-watchdog", depth: "depth-1" },
      { text: "Call Trace", href: "#call-trace", depth: "depth-2" },
      { text: "数据流", href: "#数据流", depth: "depth-3" },
      { text: "Call Trace", href: "#call-trace-2", depth: "depth-2" },
    ]
  );
  assert.equal(document.querySelector("h1").id, "runtime-watchdog");
  assert.equal(document.querySelector("h3").id, "数据流");
  assert.equal(document.querySelector("h4").id, "internal-detail", "deeper headings still get linkable anchors");
  assert.equal(toc.querySelector('a[href="#internal-detail"]'), null, "h4 and deeper stay out of the compact sidebar");
});

test("renderMarkdownPage omits the table of contents when no headings exist", () => {
  const html = renderMarkdownPage("A short paragraph without headings.", "/x/notes.md");
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector("nav.toc"), null);
  assert.equal(document.querySelector(".review-layout"), null);
  assert.ok(document.querySelector("body > main"), "the original centered document layout remains");
});

test("table of contents labels stay text-only when headings contain markdown", () => {
  const html = renderMarkdownPage("## **Bold** and [linked](https://example.com)\n", "/x/notes.md");
  const document = new JSDOM(html).window.document;
  const link = document.querySelector("nav.toc a");
  assert.equal(link.textContent, "Bold and linked");
  assert.equal(link.querySelectorAll("strong, a").length, 0, "inline formatting does not become nested navigation markup");
  assert.equal(document.querySelector("main h2 strong").textContent, "Bold");
});

test("raw HTML in markdown is visible but never active", () => {
  const html = renderMarkdownPage(
    "# Hi\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<iframe src=\"https://evil.example\"></iframe>\n\n<svg onload=alert(3)><circle /></svg>\n\n<div>Kept text</div>\n\n[Bad link](javascript:alert(4))\n\n![Bad image](data:text/html,bad)\n",
    "/x/notes.md"
  );
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll("script, iframe, svg").length, 0, "active elements are rendered only as text");
  assert.equal(
    [...document.querySelectorAll("*")].some((element) => [...element.attributes].some((attr) => /^on/i.test(attr.name))),
    false,
    "event-handler attributes never become active"
  );
  assert.equal(document.querySelectorAll('[href^="javascript:"], [src^="javascript:"], [src^="data:text/html"]').length, 0);
  assert.match(document.body.textContent, /Kept text/, "the source remains readable");
  assert.match(document.body.textContent, /Bad link/, "unsafe links retain their readable label");
});

test("normal Markdown links and images remain available", () => {
  const html = renderMarkdownPage(
    "[Relative](./spec.md) [Web](https://example.com) [Email](mailto:hi@example.com) ![Image](./image.png)",
    "/x/notes.md"
  );
  const document = new JSDOM(html).window.document;
  assert.deepEqual(
    [...document.querySelectorAll("a")].map((element) => element.getAttribute("href")),
    ["./spec.md", "https://example.com", "mailto:hi@example.com"]
  );
  assert.equal(document.querySelector("img").getAttribute("src"), "./image.png");
});

test("a markdown review is rendered, flagged, and never writable", async (t) => {
  const { port, token, dispose } = await start();
  t.after(() => dispose());

  const file = path.join(tmp, "notes.md");
  fs.writeFileSync(file, "# Notes\n\nFirst draft.\n\nSee [the spec](./spec.md).\n");
  fs.writeFileSync(path.join(tmp, "spec.md"), "# Spec\n\nDetails.\n");

  const opened = await request(port, token, { method: "POST", route: "/api/session", body: { file } });
  assert.equal(opened.status, 200);
  const { key, sessionId } = JSON.parse(opened.raw);

  await t.test("the artifact route serves rendered html with the sdk injected", async () => {
    const res = await request(port, token, { route: `/artifact/${key}/index.html` });
    assert.equal(res.status, 200);
    assert.match(res.raw, /<h1[^>]*>Notes<\/h1>/);
    assert.match(res.raw, /data-eh-sdk/);
    assert.doesNotMatch(res.raw, /# Notes/, "raw markdown syntax does not leak through");
  });

  await t.test("page state marks the page as markdown", async () => {
    const res = await request(port, token, { route: `/api/page/${key}` });
    assert.equal(JSON.parse(res.raw).markdown, true);
  });

  await t.test("saves are refused so the source file survives", async () => {
    const res = await request(port, token, {
      method: "POST",
      route: `/api/page/${key}/save`,
      body: { html: "<!DOCTYPE html><html><body>overwritten</body></html>" },
    });
    assert.equal(res.status, 400);
    assert.equal(fs.readFileSync(file, "utf8"), "# Notes\n\nFirst draft.\n\nSee [the spec](./spec.md).\n");
  });

  await t.test("navigation can follow a link to a sibling markdown page", async () => {
    const res = await request(port, token, {
      method: "POST",
      route: `/api/session/${sessionId}/navigate`,
      body: { href: "./spec.md" },
    });
    assert.equal(res.status, 200);
    const nav = JSON.parse(res.raw);
    assert.equal(nav.page.markdown, true);
    assert.equal(nav.page.filename, "spec.md");
  });

  await t.test("comments on a markdown page ship in the batch with the md path", async () => {
    await request(port, token, {
      method: "POST",
      route: `/api/page/${key}/comment`,
      body: { kind: "selection", quote: "First draft.", feedback: "Add a timeline." },
    });
    const sent = await request(port, token, {
      method: "POST",
      route: `/api/page/${key}/send`,
      body: { sessionId, note: "Keep the design concise." },
    });
    assert.equal(sent.status, 200);
    const sentPage = JSON.parse(sent.raw).page;
    assert.equal(sentPage.lastReview.overall_note, "Keep the design concise.");
    assert.equal(sentPage.lastReview.comments[0].feedback, "Add a timeline.");
    assert.ok(sentPage.lastReview.sent_at, "the history records when it was sent");
    const polled = await request(port, token, { route: `/api/poll?file=${encodeURIComponent(file)}` });
    const batch = JSON.parse(polled.raw);
    assert.equal(batch.status, "feedback");
    // The server canonicalizes paths (symlinked tmpdirs on macOS), so match on realpath.
    const page = batch.pages.find((p) => p.file === fs.realpathSync(file));
    assert.equal(page.comments[0].feedback, "Add a timeline.");
    assert.match(batch.next_step, /Markdown source/);

    await acknowledge(port, token, file);
    const afterAck = JSON.parse((await request(port, token, { route: `/api/page/${key}` })).raw);
    assert.deepEqual(afterAck.comments, [], "ack clears the live comment queue");
    assert.deepEqual(afterAck.edits, [], "ack clears the live edit queue");
    assert.equal(afterAck.lastReview.comments[0].feedback, "Add a timeline.", "the last sent review remains visible after ack");
    assert.equal(afterAck.lastReview.overall_note, "Keep the design concise.");
  });
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
