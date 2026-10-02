import { describe, expect, it } from "vitest";
import { resourcesForEvent } from "./directoryRefresh";

describe("resourcesForEvent", () => {
  it("refetches exactly one resource for collection/tag events", () => {
    expect(resourcesForEvent("collection-changed")).toEqual(["collections"]);
    expect(resourcesForEvent("tag-changed")).toEqual(["tags"]);
  });

  it("fans document events out to the counts they move (lists + stats)", () => {
    // Collections/tags lists embed document_count badges; stats counts
    // approved documents. One document change can move all three.
    expect(resourcesForEvent("document-uploaded")).toEqual(["collections", "tags", "stats"]);
    expect(resourcesForEvent("document-approved")).toEqual(["collections", "tags", "stats"]);
  });

  it("ignores events that never touch directory data (zero refetches)", () => {
    for (const event of [
      "member-joined",
      "member-kicked",
      "chat-created",
      "chat-imported",
      "project-changed",
    ] as const) {
      expect(resourcesForEvent(event)).toEqual([]);
    }
  });
});
