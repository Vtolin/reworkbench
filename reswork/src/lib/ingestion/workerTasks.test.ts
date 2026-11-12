import { describe, expect, it, vi } from "vitest";
import { chunkTextWithPages, sha256Hex } from "./chunking";
import { runIngestTask } from "./workerTasks";

vi.mock("@/lib/ai/ollama", () => ({
  OllamaProvider: class {
    embed = async (): Promise<number[]> => {
      throw new Error("embedder down");
    };
  },
}));

describe("runIngestTask", () => {
  it("extracts a text file, hashes it and proposes metadata", async () => {
    const file = new File(
      ["Deep learning for legal research\nJane Doe\n© 2024\nAbstract\nBody text."],
      "paper.txt",
      { type: "text/plain" },
    );
    const response = await runIngestTask({ id: 7, kind: "analyze", payload: { file } });
    expect(response).toMatchObject({ id: 7, kind: "analyze", ok: true });
    if (!response.ok || response.kind !== "analyze") throw new Error("expected analyze result");
    expect(response.result.text).toContain("Body text.");
    expect(response.result.pageCount).toBe(1);
    expect(response.result.extractionError).toBeNull();
    expect(response.result.fileHash).toBe(await sha256Hex(await file.arrayBuffer()));
    expect(response.result.fileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(response.result.analysis.title).toBe("Deep learning for legal research");
    expect(response.result.analysis.year).toBe(2024);
  });

  it("returns extraction failures instead of dropping them", async () => {
    const file = new File(["definitely not a zip"], "broken.docx");
    const response = await runIngestTask({ id: 8, kind: "analyze", payload: { file } });
    if (!response.ok || response.kind !== "analyze") throw new Error("expected analyze result");
    expect(response.result.text).toBe("");
    expect(response.result.pageCount).toBeNull();
    expect(response.result.extractionError).toBeTruthy();
  });

  it("chunks page-aware text exactly like the direct pipeline", async () => {
    const text = `[Page 1]\n${"a".repeat(5000)}\n\n[Page 2]\nShort page.`;
    const response = await runIngestTask({ id: 9, kind: "chunk", payload: { text } });
    if (!response.ok || response.kind !== "chunk") throw new Error("expected chunk result");
    expect(response.result).toEqual(chunkTextWithPages(text));
    expect(response.result.some((c) => c.page === 2)).toBe(true);
  });

  it("reports embedding failures as a failed task, not a crash", async () => {
    const response = await runIngestTask({
      id: 10,
      kind: "embed",
      payload: { text: "hello", mode: "local" },
    });
    expect(response).toEqual({
      id: 10,
      kind: "embed",
      ok: false,
      error: "embedder down",
    });
  });
});
