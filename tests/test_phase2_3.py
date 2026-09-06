"""
Phase 2/3 unit tests: CSL engine, reference parsers, legal extraction.
Run: python -m unittest discover -s tests -v
"""
import json
import unittest

from core.citations import engine
from core.importing import parsers
from core.legal.extraction import (
    extract_case_metadata, extract_cited_identifiers, normalize_case_number,
)


class TestCslEngine(unittest.TestCase):
    def _doc(self, **overrides):
        doc = {
            "id": 1, "title": "Proportionality in Indonesian Constitutional Review",
            "original_filename": "x.pdf", "authors": ["John Doe", "Jane Roe"],
            "year": 2021, "journal": "Journal of Legal Studies",
            "volume": "12", "issue": "3", "pages": "45-67",
            "publisher": "Example Publisher", "doi": "10.1234/example.1",
            "document_type": "journal", "citation_metadata": {},
        }
        doc.update(overrides)
        return doc

    def test_doc_to_csl_item_mapping(self):
        item = engine.doc_to_csl_item(self._doc())
        self.assertEqual(item["type"], "article-journal")
        self.assertEqual(item["author"][0], {"family": "Doe", "given": "John"})
        self.assertEqual(item["issued"], {"date-parts": [[2021]]})
        self.assertEqual(item["container-title"], "Journal of Legal Studies")
        self.assertEqual(item["volume"], "12")
        self.assertEqual(item["page"], "45-67")
        self.assertEqual(item["DOI"], "10.1234/example.1")

    def test_legal_case_maps_authority_and_number(self):
        doc = self._doc(document_type="legal",
                        citation_metadata={"court": "Mahkamah Konstitusi",
                                           "case_number": "90/PUU-XXI/2023"})
        item = engine.doc_to_csl_item(doc)
        self.assertEqual(item["type"], "legal_case")
        self.assertEqual(item["authority"], "Mahkamah Konstitusi")
        self.assertEqual(item["number"], "90/PUU-XXI/2023")

    def test_render_apa_and_oscola(self):
        item = engine.doc_to_csl_item(self._doc())
        apa = engine.render_citation(item, "apa")
        oscola = engine.render_citation(item, "oscola")
        self.assertIn("Doe, J.", apa)
        self.assertIn("2021", apa)
        self.assertIn("Doe J", oscola)
        self.assertNotEqual(apa, oscola)

    def test_unknown_style_falls_back_to_apa(self):
        item = engine.doc_to_csl_item(self._doc())
        out = engine.render_citation(item, "definitely-not-a-style")
        self.assertIn("Doe", out)

    def test_bibliography_sorted(self):
        docs = [self._doc(id=1, title="Beta paper", authors=["Zed Zeta"], year=2020),
                self._doc(id=2, title="Alpha paper", authors=["Ann Able"], year=2021)]
        items = [engine.doc_to_csl_item(d) for d in docs]
        entries = engine.render_bibliography(items, "apa")
        self.assertEqual(len(entries), 2)
        self.assertTrue(entries[0].startswith("Able"))

    def test_style_list_and_custom(self):
        styles = engine.list_styles()
        ids = {s["id"] for s in styles}
        self.assertIn("apa", ids)
        self.assertIn("oscola", ids)
        self.assertIn("bluebook-law-review", ids)


class TestImportParsers(unittest.TestCase):
    def test_parse_bibtex_with_nested_braces(self):
        text = "@article{k, title = {A Study of {LLM} Grading}, author = {Doe, Jane}, year = {2021}}"
        recs = parsers.parse_bibtex(text)
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["title"], "A Study of LLM Grading")
        self.assertEqual(recs[0]["authors"], ["Doe, Jane"])
        self.assertEqual(recs[0]["year"], 2021)

    def test_parse_bibtex_multiple_and_quoted(self):
        text = ('@article{a, title = {First}, author = {A, B and C, D}}\n'
                '@book{b, title = "Second", year = 1999}')
        recs = parsers.parse_bibtex(text)
        self.assertEqual(len(recs), 2)
        self.assertEqual(recs[0]["authors"], ["A, B", "C, D"])

    def test_parse_ris(self):
        text = "TY  - JOUR\nAU  - Smith, John\nTI  - T\nPY  - 2020\nSP  - 1\nEP  - 5\nER  - "
        recs = parsers.parse_ris(text)
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["authors"], ["Smith, John"])
        self.assertEqual(recs[0]["pages"], "1-5")

    def test_parse_csl_json(self):
        text = json.dumps([{"title": "T", "author": [{"family": "Doe", "given": "J"}],
                            "issued": {"date-parts": [[2022]]}, "DOI": "10.1/x"}])
        recs = parsers.parse_csl_json(text)
        self.assertEqual(recs[0]["authors"], ["J Doe"])
        self.assertEqual(recs[0]["year"], 2022)

    def test_parse_endnote_xml(self):
        text = ('<xml><records><record><title>Old Thesis</title>'
                '<authors><author>Alice A</author></authors>'
                '<year>2018</year></record></records></xml>')
        recs = parsers.parse_endnote_xml(text)
        self.assertEqual(recs[0]["title"], "Old Thesis")
        self.assertEqual(recs[0]["authors"], ["Alice A"])

    def test_detect_format(self):
        self.assertEqual(parsers.detect_format("@article{x, title={T}}"), "bibtex")
        self.assertEqual(parsers.detect_format("TY  - JOUR\nTI  - T"), "ris")
        self.assertEqual(parsers.detect_format('{"title": "T"}'), "csl-json")
        self.assertEqual(parsers.detect_format("<xml><records/>"), "endnote-xml")

    def test_parse_garbage_returns_empty(self):
        self.assertEqual(parsers.parse_references("hello world this is not a reference"), [])

    def test_serializers_roundtrip(self):
        doc = {"id": 1, "title": "T", "authors": ["Doe, Jane"], "year": 2020,
               "journal": "J", "volume": "1", "issue": "2", "pages": "3-4",
               "publisher": "P", "doi": "10.1/x", "abstract": "abs",
               "document_type": "journal", "citation_metadata": {}}
        self.assertIn("@article{doc1", parsers.docs_to_bibtex([doc]))
        self.assertIn("TY  - JOUR", parsers.docs_to_ris([doc]))
        self.assertIn('"title": "T"', parsers.docs_to_csl_json([doc]))


class TestLegalExtraction(unittest.TestCase):
    TEXT = """
    PUTUSAN
    Nomor 90/PUU-XXI/2023
    Mahkamah Konstitusi Republik Indonesia
    Para Pemohon: John Smith, Jane Doe
    Para Termohon: Pemerintah Republik Indonesia
    diputuskan pada tanggal 12 Maret 2024
    Menimbang bahwa Pasal 28D ayat (1) UUD 1945...
    sebagaimana Putusan Mahkamah Konstitusi Nomor 46/PUU-XIV/2016
    dan Undang-Undang Nomor 11 Tahun 2008
    """

    def test_case_metadata(self):
        meta = extract_case_metadata(self.TEXT)
        self.assertEqual(meta["court"], "Mahkamah Konstitusi")
        self.assertEqual(meta["case_number"], "90/PUU-XXI/2023")
        self.assertEqual(meta["decision_date"], "2024-03-12")
        self.assertEqual(meta["decision_type"], "putusan")
        self.assertTrue(any("Pemohon" in p for p in meta["parties"]))

    def test_normalize_case_number(self):
        self.assertEqual(normalize_case_number("No. 90/PUU-XXI/2023"), "90/PUU-XXI/2023")
        self.assertEqual(normalize_case_number("12/PDT.G/2023/PN.JKT"), "12/PDT.G/2023/PN.JKT")

    def test_cited_identifiers(self):
        refs = extract_cited_identifiers(self.TEXT)
        kinds = {(r["kind"], r["identifier"]) for r in refs}
        self.assertIn(("case", "46/PUU-XIV/2016"), kinds)
        self.assertIn(("article", "PASAL 28D AYAT (1)"), kinds)
        self.assertIn(("statute", "UNDANG-UNDANG 11/2008"), kinds)


if __name__ == "__main__":
    unittest.main()
