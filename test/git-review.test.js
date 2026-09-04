import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-git-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");

const { collectGitChanges, gitChangeFingerprint, parseUnifiedDiff, renderGitReview } = await import("../src/git-review.js");
const { canonicalTarget, targetKey } = await import("../src/paths.js");
const { start } = await import("../src/server.js");

function run(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  run(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(repo, "app.txt"), "alpha\nbeta\ngamma\n");
  fs.writeFileSync(path.join(repo, "delete.txt"), "remove me\n");
  fs.writeFileSync(path.join(repo, "file with space.txt"), "space file\n");
  run(repo, ["add", "app.txt", "delete.txt", "file with space.txt"]);
  run(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "initial"]);
  fs.writeFileSync(path.join(repo, "app.txt"), "alpha\nbeta changed\ngamma\ndelta\n");
  fs.rmSync(path.join(repo, "delete.txt"));
  fs.writeFileSync(path.join(repo, "file with space.txt"), "space changed\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "new file\nsecond line\n");
  fs.writeFileSync(path.join(repo, "image.bin"), Buffer.from([0, 1, 2]));
  return fs.realpathSync(repo);
}

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
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function waitForEvent(port, token, sessionId, name, { timeoutMs = 5000, afterOpen = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/events/${sessionId}`,
        headers: { "x-human-review-token": token },
      },
      (res) => {
        let buffer = "";
        const timer = setTimeout(() => {
          req.destroy();
          reject(new Error(`timed out waiting for ${name}`));
        }, timeoutMs);
        res.setEncoding("utf8");
        let opened = false;
        res.on("data", (chunk) => {
          buffer += chunk;
          if (!opened && buffer.includes(": open\n\n")) {
            opened = true;
            if (afterOpen) Promise.resolve().then(afterOpen).catch(reject);
          }
          if (!buffer.includes(`event: ${name}\n`)) return;
          clearTimeout(timer);
          req.destroy();
          resolve();
        });
      }
    );
    req.on("error", (err) => {
      if (err.code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}

test("parseUnifiedDiff tracks old and new line coordinates", () => {
  const files = parseUnifiedDiff(
    "diff --git a/app.txt b/app.txt\n" +
      "--- a/app.txt\n" +
      "+++ b/app.txt\n" +
      "@@ -1,3 +1,4 @@\n" +
      " alpha\n" +
      "-beta\n" +
      "+beta changed\n" +
      " gamma\n" +
      "+delta\n"
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "app.txt");
  assert.deepEqual(
    files[0].hunks[0].lines.map(({ type, oldLine, newLine }) => ({ type, oldLine, newLine })),
    [
      { type: "context", oldLine: 1, newLine: 1 },
      { type: "delete", oldLine: 2, newLine: null },
      { type: "add", oldLine: null, newLine: 2 },
      { type: "context", oldLine: 3, newLine: 3 },
      { type: "add", oldLine: null, newLine: 4 },
    ]
  );
});

test("a repository without HEAD still shows untracked changes", () => {
  const repo = fs.mkdtempSync(path.join(tmp, "new-repo-"));
  run(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(repo, "first.txt"), "first line\n");
  const changes = collectGitChanges(repo);
  assert.equal(changes.files.length, 1);
  assert.equal(changes.files[0].path, "first.txt");
  assert.equal(changes.files[0].status, "untracked");
});

test("collectGitChanges includes tracked, deleted, untracked, binary, and spaced paths", () => {
  const repo = createRepo();
  const changes = collectGitChanges(repo);
  assert.deepEqual(
    new Set(changes.files.map((file) => file.path)),
    new Set(["app.txt", "delete.txt", "file with space.txt", "untracked.txt", "image.bin"])
  );
  assert.equal(changes.files.find((file) => file.path === "delete.txt").status, "deleted");
  assert.equal(changes.files.find((file) => file.path === "untracked.txt").status, "untracked");
  assert.equal(changes.files.find((file) => file.path === "image.bin").binary, true);
  assert.ok(changes.stats.additions >= 5);
  assert.ok(changes.stats.deletions >= 3);
});

test("renderGitReview folds long unchanged context while keeping hidden lines addressable", () => {
  const repo = fs.mkdtempSync(path.join(tmp, "long-repo-"));
  run(repo, ["init", "-q"]);
  const original = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
  fs.writeFileSync(path.join(repo, "long.txt"), `${original.join("\n")}\n`);
  run(repo, ["add", "long.txt"]);
  run(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "initial"]);
  const changed = [...original];
  changed[39] = "line 40 changed";
  fs.writeFileSync(path.join(repo, "long.txt"), `${changed.join("\n")}\n`);

  const document = new JSDOM(renderGitReview(repo).html).window.document;
  const folds = [...document.querySelectorAll("details.fold")];
  assert.ok(folds.length >= 2, "long context before and after the change is folded");
  assert.match(folds[0].querySelector("summary").textContent, /Show \d+ unchanged lines/);
  assert.equal(folds[0].querySelector("summary").hasAttribute("data-eh-ui"), true);
  assert.ok(folds[0].querySelector('[data-git-kind="line"][data-git-path="long.txt"]'), "folded lines retain comment anchors");
  assert.ok(document.querySelector('[data-git-path="long.txt"][data-git-new-line="40"]'), "the changed line remains visible and addressable");
});

test("renderGitReview emits a read-only navigable diff with structured line anchors", () => {
  const repo = createRepo();
  fs.mkdirSync(path.join(repo, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "nested", "feature.txt"), "nested change\n");
  const rendered = renderGitReview(repo);
  const document = new JSDOM(rendered.html).window.document;
  assert.ok(document.querySelector("nav.files[data-eh-ui]"));
  const row = document.querySelector('[data-git-path="app.txt"][data-git-side="new"][data-git-new-line="2"]');
  assert.ok(row, "the changed new line has structured Git coordinates");
  assert.match(row.textContent, /beta changed/);
  assert.equal(document.body.hasAttribute("contenteditable"), false);
  assert.match(document.querySelector('a[title="file with space.txt"]').getAttribute("href"), /^#file-/);

  const tree = document.querySelector('[data-git-nav-view="tree"]');
  const list = document.querySelector('[data-git-nav-view="list"]');
  assert.ok(tree.querySelector("details.tree-dir summary"), "nested paths are represented as directories");
  assert.equal(list.hidden, true, "tree navigation is the default");
  const treeLink = tree.querySelector('a[title="src/nested/feature.txt"]');
  const listLink = list.querySelector('a[title="src/nested/feature.txt"]');
  assert.ok(treeLink && listLink, "both navigation modes include every file");
  assert.equal(treeLink.getAttribute("href"), listLink.getAttribute("href"), "tree and list share stable anchors");
  assert.equal(document.querySelector('[data-git-nav-mode="tree"]').getAttribute("aria-pressed"), "true");
  const resizer = document.querySelector('.nav-resizer[role="separator"]');
  assert.ok(resizer, "the file navigation exposes a resize handle");
  assert.equal(resizer.getAttribute("aria-valuemin"), "180");
  assert.equal(resizer.getAttribute("aria-valuemax"), "520");
  assert.match(rendered.html, /--git-nav-width: 260px/);
  assert.match(rendered.html, /margin-left: var\(--git-nav-width\)/);
});

test("Git targets are canonical and stable from nested directories", () => {
  const repo = createRepo();
  const nested = path.join(repo, "nested");
  fs.mkdirSync(nested);
  assert.deepEqual(canonicalTarget(nested), { kind: "git", value: repo });
  assert.equal(targetKey(nested), targetKey(repo));
});

test("opening the same Git target reuses its active session and ending it permits a new one", async (t) => {
  const repo = createRepo();
  const nested = path.join(repo, "nested");
  fs.mkdirSync(nested);
  const { port, token, dispose } = await start();
  t.after(() => dispose());

  const first = JSON.parse((await request(port, token, { method: "POST", route: "/api/session", body: { target: repo } })).raw);
  assert.equal(first.reused, false);
  const second = JSON.parse((await request(port, token, { method: "POST", route: "/api/session", body: { target: nested } })).raw);
  assert.equal(second.reused, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.path, first.path);

  const ended = await request(port, token, { method: "POST", route: `/api/session/${first.sessionId}/end` });
  assert.equal(ended.status, 200);
  const third = JSON.parse((await request(port, token, { method: "POST", route: "/api/session", body: { target: repo } })).raw);
  assert.equal(third.reused, false);
  assert.notEqual(third.sessionId, first.sessionId);
});

test("gitChangeFingerprint changes with working-tree content without building a patch", () => {
  const repo = createRepo();
  const before = gitChangeFingerprint(repo);
  fs.appendFileSync(path.join(repo, "app.txt"), "fingerprint update\n");
  const after = gitChangeFingerprint(repo);
  assert.notEqual(after, before);
});

test("a Git review reloads when the working tree changes", async (t) => {
  const repo = createRepo();
  const { port, token, dispose } = await start();
  t.after(() => dispose());
  const opened = await request(port, token, { method: "POST", route: "/api/session", body: { target: repo } });
  assert.equal(opened.status, 200, opened.raw);
  const { sessionId } = JSON.parse(opened.raw);
  await waitForEvent(port, token, sessionId, "reload", {
    afterOpen: () => fs.appendFileSync(path.join(repo, "app.txt"), "agent update\n"),
  });
});

test("a Git review is read-only and ships structured comments", async (t) => {
  const repo = createRepo();
  const { port, token, dispose } = await start();
  t.after(() => dispose());

  const opened = await request(port, token, { method: "POST", route: "/api/session", body: { target: repo } });
  assert.equal(opened.status, 200, opened.raw);
  const { key, sessionId } = JSON.parse(opened.raw);

  const page = JSON.parse((await request(port, token, { route: `/api/page/${key}` })).raw);
  assert.equal(page.kind, "git");
  assert.equal(page.git, true);
  assert.equal(page.repo, repo);
  assert.deepEqual(page.edits, []);

  const artifact = await request(port, token, { route: `/artifact/${key}/index.html` });
  assert.equal(artifact.status, 200);
  assert.match(artifact.raw, /git-client\.js/);
  assert.match(artifact.raw, /data-git-path="app\.txt"/);
  assert.doesNotMatch(artifact.raw, /src="\/sdk\.js/);

  const raw = await request(port, token, { route: `/api/page/${key}/raw` });
  assert.equal(raw.status, 400);
  const saved = await request(port, token, {
    method: "POST",
    route: `/api/page/${key}/save`,
    body: { html: "<p>overwrite</p>" },
  });
  assert.equal(saved.status, 400);

  const anchor = {
    selector: "#line-example",
    git: {
      kind: "line",
      path: "app.txt",
      side: "new",
      line: 2,
      old_line: null,
      new_line: 2,
      hunk: "@@ -1,3 +1,4 @@",
      text: "beta changed",
    },
  };
  await request(port, token, {
    method: "POST",
    route: `/api/page/${key}/comment`,
    body: { kind: "element", quote: "app.txt:2", anchor, feedback: "Why does this behavior change?" },
  });
  await request(port, token, {
    method: "POST",
    route: `/api/page/${key}/send`,
    body: { sessionId, note: "Review the worktree changes." },
  });
  const batch = JSON.parse((await request(port, token, { route: `/api/poll?target=${encodeURIComponent(repo)}` })).raw);
  assert.equal(batch.pages[0].kind, "git");
  assert.equal(batch.pages[0].repo, repo);
  assert.deepEqual(batch.pages[0].comments[0].anchor.git, anchor.git);
  assert.deepEqual(batch.pages[0].edits, []);
  assert.match(batch.next_step, /anchor\.git/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
