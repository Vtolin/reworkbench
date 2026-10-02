import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Phase 5 structural guards: the scalability migration must carry every
// index/RPC hardening the query layer relies on, and the wide tables must
// never regress to select("*"). EXPLAIN-before/after against a live database
// is a staging follow-up (no live Supabase in CI) — the exact queries to run
// are documented below; these guards pin the definitions they depend on.
//
// Staging EXPLAIN checklist (run after applying 0014):
//   EXPLAIN (ANALYZE, BUFFERS)
//   SELECT id FROM authors WHERE workspace_id = '<ws>' AND name ILIKE '%smith%';
//     → BitmapAnd/BitmapOr over idx_authors_ws + idx_authors_name_trgm
//       (before: Seq Scan on authors).
//   EXPLAIN (ANALYZE, BUFFERS)
//   SELECT id, title FROM documents WHERE workspace_id = '<ws>' AND title ILIKE '%report%';
//     → Bitmap heap scan via idx_documents_title_trgm (before: Seq Scan /
//       plain idx_documents_ws filter + heap filter).
//   EXPLAIN (ANALYZE, BUFFERS)
//   SELECT * FROM fts_search_chunks('<ws>', 'quantum error correction', 20);
//     → tsquery parsed once (InitPlan/CTE), limit capped at 50.
//   EXPLAIN (ANALYZE, BUFFERS)
//   SELECT * FROM vector_search_chunks('<ws>', '<768d>'::vector, 20);
//     → embeddings filtered on e.workspace_id via idx_embeddings_ws.

const ROOT = path.join(__dirname, "..");

function migration(name: string): string {
  return fs.readFileSync(path.join(ROOT, "supabase", "migrations", name), "utf8");
}

function src(rel: string): string {
  return fs.readFileSync(path.join(__dirname, rel), "utf8");
}

describe("migration 0014 (search scalability)", () => {
  const sql = migration("0014_search_scalability.sql");

  it("indexes every ilike site (trigram) plus workspace scoping", () => {
    for (const idx of [
      "idx_authors_name_trgm",
      "idx_collections_name_trgm",
      "idx_tags_name_trgm",
      "idx_documents_title_trgm",
      "idx_authors_ws",
      "idx_collections_ws",
      "idx_tags_ws",
    ]) {
      expect(sql).toContain(idx);
    }
    expect(sql).toContain("gin_trgm_ops");
  });

  it("adds the missing scoping indexes", () => {
    for (const idx of ["idx_annotations_ws", "idx_trail_project", "idx_claims_ws_project"]) {
      expect(sql).toContain(idx);
    }
  });

  it("denormalizes embeddings.workspace_id in staged, backfilled order", () => {
    // Section C only (the header rollback note names the same objects).
    const staged = sql.slice(sql.indexOf("-- C."));
    const add = staged.indexOf("add column if not exists workspace_id");
    const trigger = staged.indexOf("create or replace function public.stamp_embedding_workspace");
    const backfill = staged.indexOf("and e.workspace_id is null");
    const notNull = staged.indexOf("alter column workspace_id set not null");
    const index = staged.indexOf("idx_embeddings_ws");
    expect([add, trigger, backfill, notNull, index].every((i) => i >= 0)).toBe(true);
    // Staged safely: trigger before backfill before NOT NULL before index.
    expect(add).toBeLessThan(trigger);
    expect(trigger).toBeLessThan(backfill);
    expect(backfill).toBeLessThan(notNull);
    expect(notNull).toBeLessThan(index);
    expect(sql).toContain("e.workspace_id = ws_id");
  });

  it("hardens both retrieval RPCs (clamp, single tsquery parse, timeout)", () => {
    expect(sql).toContain("least(greatest(match_count, 1), 50)");
    expect(sql).toContain("websearch_to_tsquery('english', q) as ts");
    expect(sql.match(/websearch_to_tsquery\('english', q\)/g)?.length).toBe(1);
    expect(sql.match(/set statement_timeout = '10s'/g)?.length).toBe(2);
  });

  it("preserves RLS (no policies touched, membership guards kept)", () => {
    expect(sql).not.toMatch(/create policy|drop policy/i);
    expect(sql).toContain("public.is_workspace_member(ws_id)");
  });
});

describe("no select-star on wide tables", () => {
  it("keeps explicit columns in search and related", () => {
    for (const rel of ["lib/wb/search.ts", "lib/wb/related.ts"]) {
      const text = src(rel);
      expect(text).not.toMatch(/\.select\(\s*"\*"\s*\)/);
    }
    expect(src("lib/wb/search.ts")).toContain("SAVED_SEARCH_COLUMNS");
    expect(src("lib/wb/related.ts")).toContain("ANNOTATION_COLUMNS");
  });

  it("keeps documents/chat_messages explicit in export (small tables loop exempt)", () => {
    const text = src("lib/wb/export.ts");
    expect(text).toContain("DOCUMENT_COLUMNS_SELECT");
    expect(text).toContain("CHAT_MESSAGE_COLUMNS");
    // Exactly one select("*") remains: the bounded small-tables loop.
    const stars = text.split("\n").filter((l) => /\.select\(\s*"\*"\s*\)/.test(l));
    expect(stars.length).toBe(1);
    expect(stars[0]).toContain("sb.from(t)");
  });
});
