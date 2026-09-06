"""
Backend smoke test for Phase 2-9 endpoints (no LLM, no network).
Run: python tests/smoke_endpoints.py  (from project root)
"""
import os
import sys
import warnings

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient
import server
from storage.sqlite import get_connection


def main():
    warnings.filterwarnings("ignore")
    c = TestClient(server.app)
    ok = True

    def check(name, cond, extra=""):
        nonlocal ok
        status = "OK " if cond else "FAIL"
        if not cond:
            ok = False
        print(f"[{status}] {name} {extra}")

    doc_id = None
    cid = None
    sid = None
    try:
        # 1. CSL styles
        r = c.get("/api/citations/styles")
        check("GET /api/citations/styles", r.status_code == 200 and len(r.json()["styles"]) >= 7,
              f"styles={len(r.json().get('styles', []))} default={r.json().get('default')}")

        # 2. import a BibTeX reference
        bib = """@article{test2020,
          title = {Imported Reference Title},
          author = {Doe, Jane},
          journal = {J. Import},
          year = {2020},
          volume = {1}, pages = {10--20},
          doi = {10.9999/import.test}
        }"""
        r = c.post("/api/import/refs", json={"text": bib})
        j = r.json()
        check("POST /api/import/refs", r.status_code == 200 and j["imported"] == 1, str(j))
        doc_id = j["documents"][0]["id"]

        # 3. CSL citation render for the imported doc
        r = c.get(f"/api/citations/{doc_id}?style=apa")
        j = r.json()
        check("GET /api/citations?style=apa", r.status_code == 200 and "Doe, J." in j["citation"], j.get("citation", ""))
        r = c.get(f"/api/citations/{doc_id}?style=oscola")
        check("GET /api/citations?style=oscola", r.status_code == 200 and "Doe J" in r.json()["citation"], r.json().get("citation", ""))

        # 4. custom CSL style save (invalid XML rejected)
        r = c.post("/api/citations/styles/custom", json={"xml": "<not-a-style>"})
        check("custom CSL invalid rejected", r.status_code == 400)

        # 5. export refs (ris + csl-json) includes imported doc
        r = c.get(f"/api/export/refs?format=ris&ids={doc_id}")
        check("GET /api/export/refs ris", r.status_code == 200 and "TY  - JOUR" in r.json()["data"])
        r = c.get(f"/api/export/refs?format=csl-json&ids={doc_id}")
        check("GET /api/export/refs csl-json", r.status_code == 200 and "Imported Reference Title" in r.json()["data"])

        # 6. bibliography export
        r = c.get(f"/api/export/bibliography?style=apa&ids={doc_id}")
        check("GET /api/export/bibliography", r.status_code == 200 and len(r.json()["bibliography"]) >= 1)

        # 7. duplicate import is skipped
        r = c.post("/api/import/refs", json={"text": bib})
        check("duplicate import skipped", r.status_code == 200 and r.json()["skipped"] == 1)

        # 8. saved searches
        r = c.post("/api/searches", json={"name": "smoke", "query": "constitutional", "filters": {"year": 2020}})
        sid = r.json()["id"]
        r = c.get("/api/searches")
        check("GET /api/searches", r.status_code == 200 and any(s["id"] == sid for s in r.json()))
        r = c.post(f"/api/searches/{sid}/run")
        check("POST /api/searches/{id}/run", r.status_code == 200)
        c.delete(f"/api/searches/{sid}")
        sid = None

        # 9. claims
        r = c.post("/api/claims", json={"text": "Smoke claim: the court balanced rights."})
        cid = r.json()["id"]
        check("POST /api/claims", r.status_code == 200 and r.json()["evidence"] is not None)
        r = c.post(f"/api/claims/{cid}/citations", json={"document_id": doc_id, "support": "supports", "locator": "p.3"})
        check("POST /api/claims/{id}/citations", r.status_code == 200)
        r = c.post(f"/api/claims/{cid}/citations", json={"document_id": doc_id, "support": "contradicts"})
        claim = r.json()
        supports = claim["evidence"]["supports"]
        contradicts = claim["evidence"]["contradicts"]
        check("evidence grouped by support", len(supports) == 1 and len(contradicts) == 1)

        # 10. related documents (imported doc has no stored_path -> mostly empty but 200)
        r = c.get(f"/api/library/documents/{doc_id}/related")
        check("GET /related", r.status_code == 200 and set(r.json().keys()) == {"semantic", "shared_authors", "shared_topics", "citations"})

        # 11. references resolver (metadata-only doc: falls back to snippet, no crash)
        r = c.get(f"/api/library/documents/{doc_id}/references")
        check("GET /references", r.status_code == 200)

        # 12. legal refresh without text -> 400 (no chunks, no snippet)
        r = c.post(f"/api/library/documents/{doc_id}/legal/refresh")
        check("legal refresh no-text handled", r.status_code in (400, 200), f"status={r.status_code}")

        # 13. cases citing query
        r = c.get("/api/cases/citing", params={"case_number": "90/PUU-XXI/2023"})
        check("GET /api/cases/citing", r.status_code == 200)

        # 14. matrix export (csv/md/xlsx) with client-supplied rows
        rows = [{"paper": "P", "year": 2020, "method": "m", "dataset": "d", "findings": "f", "limitations": "l"}]
        r = c.post("/api/research/matrix/export", json={"rows": rows, "format": "csv"})
        check("matrix csv", r.status_code == 200 and "paper,year" in r.text)
        r = c.post("/api/research/matrix/export", json={"rows": rows, "format": "md"})
        check("matrix md", r.status_code == 200 and "| Paper |" in r.json()["markdown"])
        r = c.post("/api/research/matrix/export", json={"rows": rows, "format": "xlsx"})
        check("matrix xlsx", r.status_code == 200 and r.headers.get("content-type", "").startswith("application/vnd.openxmlformats"))

        # 15. citation style default persistence
        r = c.put("/api/citations/styles/default", json={"style": "oscola"})
        check("PUT default style", r.status_code == 200 and r.json()["default"] == "oscola")
        r = c.put("/api/citations/styles/default", json={"style": "apa"})
        check("PUT default style back", r.status_code == 200)
    finally:
        # cleanup even on failure so re-runs start clean
        try:
            if doc_id is not None:
                c.delete(f"/api/library/documents/{doc_id}")
        except Exception:
            pass
        try:
            if cid is not None:
                c.delete(f"/api/claims/{cid}")
        except Exception:
            pass
        try:
            if sid is not None:
                c.delete(f"/api/searches/{sid}")
        except Exception:
            pass

    print("RESULT:", "ALL OK" if ok else "FAILURES PRESENT")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
