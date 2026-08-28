---
name: human-review
description: Open an HTML file, Markdown file, or localhost page in the browser so the user can edit text, leave contextual comments, and converse with the agent through direct replies. Use after writing or updating anything the user will read — specs, plans, reports, newsletter drafts, landing pages, slide decks, and locally running web pages.
---

# human-review

The user reviews your HTML, Markdown, or localhost page in a real browser: they fix small things
by typing, select anything to comment on it, and send you the whole batch at once.

Markdown files open rendered. Their quotes and edits reference the rendered text,
and the file itself is never touched — apply every change to the Markdown source,
keeping its formatting syntax.

## The loop

1. Write or update the HTML or Markdown file, or start the local page being reviewed.
2. Open it for the user:

   ```sh
   npx -y human-review path/to/file.html
   ```

   For a page served by a local development server, open the real route instead
   of recreating it as a separate HTML file:

   ```sh
   npx -y human-review http://localhost:3000/wiki
   ```

3. Wait for feedback. This blocks until they hit Send, or the timeout passes:

   ```sh
   npx -y human-review poll path/to/file.html --timeout 600
   ```

   Keep this command in the foreground. Do not end your turn while it is waiting.
   If your shell returns a process or session handle, keep waiting on that handle
   until the command exits. If it prints `{"status":"timeout"}`, no feedback has
   arrived yet — run the same poll command again to keep waiting. Feedback is
   saved even if a poll dies, so nothing is ever lost.

   If it prints `{"status":"closed"}`, the user ended the review from the
   browser — stop polling and do not run the poll command again. Unsent
   feedback is kept and ships the next time this target is reviewed.

4. Handle what comes back. Comments may be change requests, questions, or discussion:

   - Update the source when a change is appropriate.
   - Reply directly when the user is asking a question or a source change is unnecessary.
   - Do both when an explanation helps alongside a change.
   - A reply is optional; use your judgment instead of mechanically answering every comment.

   Reply to one comment using its `id` and the page's `file` or `url` as the target:

   ```sh
   npx -y human-review reply path/to/file.html c_123 --message "Your answer here"
   ```

   Reply to the batch's Overall note with the reserved thread id `overall`:

   ```sh
   npx -y human-review reply path/to/file.html overall --message "Your answer here"
   ```

   Then wait again. `--ack` clears the batch you handled while preserving the review and your replies in the browser:

   ```sh
   npx -y human-review poll path/to/file.html --ack --timeout 600
   ```

Repeat 3–4 until the user says they are done.

Not sure whether feedback is already waiting — say, at the start of a new turn?
This answers instantly without blocking:

```sh
npx -y human-review status path/to/file.html
```

It prints `{"status": "feedback-waiting"}` when a batch is ready for a poll,
plus counts of unsent comments and edits still in the browser.

## What you get

One batch covers every page the user visited, grouped by file or localhost URL.

```json
{
  "status": "feedback",
  "pages": [
    {
      "file": "/abs/path/to/page.html",
      "comments": [
        { "id": "c_1", "kind": "selection", "quote": "the exact text they selected",
          "anchor": { "prefix": "...", "quote": "...", "suffix": "..." },
          "feedback": "what they want changed" }
      ],
      "edits": [
        { "label": "Problem body", "kind": "edited",
          "before": "the original wording",
          "after": "their exact new wording",
          "after_html": "their exact new wording with <strong>formatting</strong>" }
      ]
    }
  ],
  "overall_note": "feedback not tied to any one page"
}
```

## Rules

- **`edits` are changes the user already made.** `after` is their exact wording —
  carry it across verbatim and never revert it. If the HTML was generated from
  something else (MDX, Markdown, a template), apply `after` to the **source** too,
  or their fix disappears on the next build.
- When `before_html`/`after_html` are present, the user changed formatting, not
  just words — bold, italic, underline, links. Use the HTML version to carry the
  formatting into the source, translated to its syntax (e.g. `<strong>` → `**`
  in Markdown/MDX).
- A page with `kind: "url"` was edited directly in the review UI. Its `file`
  and `url` fields name the localhost route, not a writable file. Find the
  matching project source (such as MDX, TSX, or a template), apply every edit
  and deletion there, then acknowledge so the route reloads. Never write the
  rendered HTTP response back into the app.
- When an edit's `after_html` contains `<img src="assets/...">`, the user pasted
  an image: the file already exists in an `assets/` folder next to the reviewed
  file. Keep that relative path — in Markdown, reference it as
  `![](assets/...)`. Never regenerate or inline the image.
- On a localhost page, a pasted image arrives under `staged_assets`. Copy its
  local `path` into the app's appropriate asset folder, replace the temporary
  preview URL in `after_html`, and preserve the image at the user's insertion
  point. Never leave the temporary preview URL in source.
- An edit with `kind: "moved"` means the user relocated that whole block.
  Reposition it in the source without rewriting its content: it now sits right
  after the block whose text starts with `moved_after`, and right before the
  block whose text starts with `moved_before`. An empty `moved_after` means it
  is now the first block in its container.
- Comments are not always instructions to edit the source. They may ask why something works a certain way, request clarification, or invite discussion. Decide whether the best response is a source change, a direct reply, both, or no reply.
- To reply in the review page, run `npx -y human-review reply <target> <comment-id> --message <text>`. Use `overall` instead of a comment id to reply to the Overall note. Replies are attached to the corresponding thread in **Last sent review** and appear without reloading the document.
- Find a change-request comment by its `quote`; that exact string is in the file.
- `kind: "element"` points at a whole block, so `quote` is its label, not body text.
- Fix every page in `pages`, not just the first.

## Better edit labels (optional)

Name the sections you author and the user's edit list uses your names instead of
guessing from the DOM:

```html
<p data-block="Problem body">…</p>
<div data-container="Metrics callout">…</div>
```

`data-block` names a region for the edit list. `data-container` also makes the block
clickable as a comment target.
