import type { Page } from "@playwright/test";

const USER = {
  id: "e2e-user",
  email: "e2e@example.com",
  aud: "authenticated",
  role: "authenticated",
  created_at: new Date().toISOString(),
};

const SESSION = {
  access_token: "e2e-token",
  token_type: "bearer",
  expires_in: 3600,
  refresh_token: "e2e-refresh",
  user: USER,
};

const DOCS = [
  {
    id: "doc-1",
    title: "Test Document One",
    original_filename: "one.pdf",
    file_hash: "h1",
    doi: null,
    year: 2024,
    ingestion_status: "ready",
    status: "approved",
    metadata_source: "local",
    metadata_confidence: 0.5,
    storage_path: "ws1/h1.pdf",
    workspace_id: "ws1",
  },
  {
    id: "doc-2",
    title: "Test Document Two",
    original_filename: "two.pdf",
    file_hash: "h2",
    doi: null,
    year: 2023,
    ingestion_status: "ready",
    status: "approved",
    metadata_source: "local",
    metadata_confidence: 0.5,
    storage_path: "ws1/h2.pdf",
    workspace_id: "ws1",
  },
];

export async function mockSupabase(page: Page) {
  await page.route("**/auth/v1/token**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SESSION) });
  });
  await page.route("**/auth/v1/user", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(USER) });
  });
  await page.route("**/auth/v1/logout", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });

  await page.route("**/rest/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const table = (url.pathname.split("/rest/v1/")[1] || "").split("/")[0];
    const method = route.request().method();
    const accept = route.request().headers()["accept"] || "";
    const single = accept.includes("vnd.pgrst.object");

    if (method === "GET") {
      if (table === "workspace_members") {
        const row = { role: "admin", workspace_id: "ws1", workspaces: { id: "ws1", name: "Workspace", member_limit: 10 } };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(single ? row : [row]) });
        return;
      }
      if (table === "documents") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(single ? DOCS[0] : DOCS) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(single ? {} : []) });
      return;
    }

    if (method === "POST") {
      if (table === "documents") {
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: "doc-new", title: "Uploaded", workspace_id: "ws1", status: "pending" }) });
        return;
      }
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(single ? {} : []) });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(single ? {} : []) });
  });

  await page.route("**/storage/v1/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ Key: "ws1/x.pdf" }) });
  });

  await page.route("**/api/rag/search", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fts: [], vector: [] }) });
  });
  await page.route("**/api/rag/embed", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ embedding: new Array(768).fill(0.1), model: "cloud-embedding-768d" }) });
  });
  await page.route("**/api/ai/proxy", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ content: "Canned answer from the assistant.", thinking: null }) });
  });
  await page.route("**/api/ai/proxy/models", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });
  await page.route("**/api/documents/approve", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "approved" }) });
  });
  await page.route("**/api/workspaces/members", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/workspaces/limit", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ limit: 10 }) });
  });

  await page.route("http://localhost:11434/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/tags")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [] }) });
      return;
    }
    if (url.includes("/api/embeddings")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ embedding: new Array(768).fill(0.1) }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: { content: "ok" } }) });
  });

  await page.route("**/realtime/v1/**", async (route) => {
    await route.abort();
  });
}

export async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[type="email"]', "e2e@example.com");
  await page.fill('input[type="password"]', "password");
  await page.click('button:has-text("Log in")');
  await page.waitForURL("**/");
}
