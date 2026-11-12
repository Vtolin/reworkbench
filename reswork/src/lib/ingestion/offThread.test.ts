import { describe, expect, it } from "vitest";
import { chunkTextWithPages } from "./chunking";
import { analyzeFile } from "./fileAnalysis";
import { analyzeFileOffThread, chunkTextOffThread } from "./offThread";

// Node/Vitest has no Worker global, so these exercise the fallback contract:
// the off-thread entry points must behave exactly like the direct pipeline.

describe("offThread fallbacks", () => {
  it("analyzes a file directly when no worker exists", async () => {
    const file = new File(["Hello world. This is a plain text document."], "note.txt", {
      type: "text/plain",
    });
    const viaOffThread = await analyzeFileOffThread(file);
    const direct = await analyzeFile(file);
    expect(viaOffThread).toEqual(direct);
    expect(viaOffThread.text).toContain("Hello world.");
    expect(viaOffThread.fileHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("chunks directly when no worker exists", async () => {
    const text = `[Page 1]\n${"a".repeat(4800)}`;
    await expect(chunkTextOffThread(text)).resolves.toEqual(chunkTextWithPages(text));
  });
});
