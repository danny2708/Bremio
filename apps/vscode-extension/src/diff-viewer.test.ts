import { describe, expect, it } from "vitest";
import { renderDiffViewer } from "./webview";

const TWO_FILE_PATCH = [
  "diff --git a/src/one.ts b/src/one.ts",
  "index 111..222 100644",
  "--- a/src/one.ts",
  "+++ b/src/one.ts",
  "@@ -1 +1 @@",
  "-const a = 1;",
  "+const a = 2;",
  "diff --git a/src/two.ts b/src/two.ts",
  "index 333..444 100644",
  "--- a/src/two.ts",
  "+++ b/src/two.ts",
  "@@ -1 +1 @@",
  "-const b = 1;",
  "+const b = 2;",
].join("\n");

describe("per-file apply and revert in the diff viewer (S10-T5)", () => {
  it("gives every file in the patch its own apply and revert", () => {
    // The daemon and CLI have taken a `filePath` since S5-T5; the panel simply
    // never sent one, so Apply was all-or-nothing.
    const html = renderDiffViewer({ stat: "", patch: TWO_FILE_PATCH });

    expect(html).toContain('data-action="apply-diff" data-file="src/one.ts"');
    expect(html).toContain('data-action="revert-diff" data-file="src/one.ts"');
    expect(html).toContain('data-action="apply-diff" data-file="src/two.ts"');
    expect(html).toContain('data-action="revert-diff" data-file="src/two.ts"');
  });

  it("keeps whole-run buttons that name no file", () => {
    // Absence of `data-file` is what tells the daemon to take the whole patch.
    const html = renderDiffViewer({ stat: "", patch: TWO_FILE_PATCH });
    expect(html).toContain('<button class="ghost" data-action="apply-diff">Apply all</button>');
    expect(html).toContain('<button class="ghost" data-action="revert-diff">Revert all</button>');
  });

  it("still highlights the diff content inside each file", () => {
    const html = renderDiffViewer({ stat: "", patch: TWO_FILE_PATCH });
    expect(html).toContain('<div class="diff-add">+const a = 2;</div>');
    expect(html).toContain('<div class="diff-remove">-const b = 1;</div>');
    expect(html).toContain('<div class="diff-hunk">@@ -1 +1 @@</div>');
  });

  it("keeps a path that contains spaces intact", () => {
    // Splitting the header on whitespace loses these, which would then be
    // offered as a per-file button that cannot possibly match.
    const patch = [
      "diff --git a/my docs/notes.md b/my docs/notes.md",
      "--- a/my docs/notes.md",
      "+++ b/my docs/notes.md",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");

    expect(renderDiffViewer({ stat: "", patch })).toContain('data-file="my docs/notes.md"');
  });

  it("offers no per-file button for a patch whose files cannot be identified", () => {
    // A patch with no `diff --git` header: naming a file here would invent one.
    const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    const html = renderDiffViewer({ stat: "", patch });

    expect(html).not.toContain("data-file=");
    expect(html).toContain("Apply all");
  });

  it("escapes a filename rather than letting it close the attribute", () => {
    const patch = 'diff --git a/x">.ts b/x">.ts\n@@ -1 +1 @@\n-a\n+b';
    const html = renderDiffViewer({ stat: "", patch });
    expect(html).not.toContain('data-file="x">.ts"');
    expect(html).toContain("&quot;");
  });

  it("says there is nothing to show for an empty diff", () => {
    expect(renderDiffViewer({ stat: "", patch: "" })).toContain("No changes in this run.");
  });
});
