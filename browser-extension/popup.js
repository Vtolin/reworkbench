// Popup: grab the current tab's URL/title, let the user refine the DOI,
// and hand off to the background worker.
const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
const status = document.getElementById("status");

function setStatus(text, cls) {
  status.textContent = text;
  status.className = cls || "";
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    const url = tab.url || "";
    const m = url.match(DOI_RE);
    document.getElementById("doi").value = m ? m[0] : "";
    document.getElementById("title").value = tab.title || "";
  });

  document.getElementById("save").addEventListener("click", () => {
    const button = document.getElementById("save");
    button.disabled = true;
    setStatus("Capturing…", "meta");
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const doi = document.getElementById("doi").value.trim() || null;
      const title = document.getElementById("title").value.trim() || null;
      chrome.runtime.sendMessage(
        { type: "capture", url: (tab && tab.url) || null, doi, title },
        (resp) => {
          button.disabled = false;
          if (!resp) return setStatus("No response from background worker.", "err");
          if (resp.ok) {
            const d = resp.data.document || {};
            const meta = d.metadata_source ? ` • metadata: ${d.metadata_source} (${Math.round((d.metadata_confidence || 0) * 100)}%)` : "";
            setStatus(
              `✓ Saved as #${d.id} — ${d.title}${resp.data.downloaded_pdf ? " • PDF downloaded" : " • metadata only"}${meta}`,
              "ok"
            );
          } else {
            setStatus(`✗ ${resp.error || "capture failed"}`, "err");
          }
        }
      );
    });
  });
});
