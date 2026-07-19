import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(__dirname, "../../../");

// Helper to recursively find markdown files
async function getMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const res = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".bremio") {
        continue;
      }
      files.push(...(await getMarkdownFiles(res)));
    } else if (entry.name.endsWith(".md")) {
      files.push(res);
    }
  }
  return files;
}

describe("mojibake regression guard", () => {
  it("verifies public markdown files have no replacement characters or common mojibake patterns", async () => {
    const mdFiles = await getMarkdownFiles(rootDir);
    
    // We only check files that are part of public documentation as per acceptance criteria
    const publicMdFiles = mdFiles.filter((file) => {
      const relPath = path.relative(rootDir, file);
      return relPath === "README.md" || relPath.startsWith("docs" + path.sep);
    });

    expect(publicMdFiles.length).toBeGreaterThan(0);

    // Common double-encoding UTF-8 mojibake patterns:
    // 1. \uFFFD (Unicode replacement character)
    // 2. ï¿½ (UTF-8 bytes of \uFFFD: EF BF BD interpreted as ISO-8859-1 and saved back)
    // 3. â€” (UTF-8 em dash E2 80 94 double-encoded)
    // 4. â€™ (UTF-8 right single quote E2 80 99 double-encoded)
    // 5. â€œ / â€ (UTF-8 quotes double-encoded)
    // 6. Generic Ã followed by UTF-8 continuation bytes: \u00C3[\u0080-\u00BF]
    // 7. Generic â followed by two UTF-8 continuation bytes: \u00E2[\u0080-\u00BF]{2}
    const mojibakePatterns = [
      { pattern: /\uFFFD/g, label: "Unicode replacement character (\\uFFFD)" },
      { pattern: /ï¿½/g, label: "Double-encoded replacement character (ï¿½)" },
      { pattern: /â€”/g, label: "Double-encoded em dash (â€”)" },
      { pattern: /â€™/g, label: "Double-encoded right quote (â€™)" },
      { pattern: /â€[œ||||™]/g, label: "Double-encoded quotes or trademark symbols" },
      { pattern: /[\u00C3][\u0080-\u00BF]/g, label: "Double-encoded UTF-8 sequence (Ã...)" },
      { pattern: /[\u00E2][\u0080-\u00BF]{2}/g, label: "Double-encoded 3-byte UTF-8 sequence (â...)" }
    ];

    for (const filePath of publicMdFiles) {
      const relativePath = path.relative(rootDir, filePath);
      const content = await fs.readFile(filePath, "utf8");

      for (const { pattern, label } of mojibakePatterns) {
        const matches = content.match(pattern);
        expect(
          matches,
          `File "${relativePath}" contains mojibake marker: "${label}"`
        ).toBeNull();
      }
    }
  });
});
