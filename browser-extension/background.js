// Service worker: pipes capture requests from the popup to the local
// workbench API. `activeTab` gives us the current URL/title in the popup,
// but network calls live here so the popup stays permission-light.
const DEFAULT_API = "http://127.0.0.1:8000";

chrome.storage.local.get({ apiUrl: DEFAULT_API }, (cfg) => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== "capture") return;
    const apiUrl = (cfg.apiUrl || DEFAULT_API).replace(/\/+$/, "");
    fetch(`${apiUrl}/api/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: msg.url || null,
        doi: msg.doi || null,
        title: msg.title || null,
      }),
    })
      .then(async (resp) => {
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
        sendResponse({ ok: true, data: body });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // async sendResponse
  });
});
