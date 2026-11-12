// Minimal Supabase-compatible mock for E2E. Only the endpoints the smoke
// flows touch are implemented; everything else returns an empty collection.
const http = require("node:http");

const PORT = 54321;
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

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    ...headers,
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });
    return res.end();
  }

  if (url.pathname === "/health") {
    return send(res, 200, { ok: true });
  }

  // Auth
  if (url.pathname.startsWith("/auth/v1/token")) {
    return send(res, 200, SESSION);
  }
  if (url.pathname === "/auth/v1/user") {
    return send(res, 200, USER);
  }
  if (url.pathname === "/auth/v1/logout") {
    return send(res, 204, undefined);
  }

  // REST
  if (url.pathname.startsWith("/rest/v1/")) {
    const table = url.pathname.replace("/rest/v1/", "").split("/")[0];
    const accept = req.headers.accept || "";
    const single = accept.includes("vnd.pgrst.object");
    if (req.method === "GET") {
      if (table === "workspace_members") {
        const row = {
          role: "admin",
          workspace_id: "ws1",
          workspaces: { id: "ws1", name: "Workspace", member_limit: 10 },
        };
        return send(res, 200, single ? row : [row]);
      }
      if (table === "documents") {
        return send(res, 200, single ? DOCS[0] : DOCS);
      }
      if (table === "document_chunks" || table === "document_embeddings" || table === "sources" || table === "document_authors" || table === "document_collections") {
        return send(res, 200, single ? {} : []);
      }
      if (table === "rate_limits") {
        return send(res, 200, single ? {} : []);
      }
      return send(res, 200, single ? {} : []);
    }
    if (req.method === "POST") {
      if (table === "documents") {
        return send(res, 201, { id: "doc-new", title: "Uploaded", workspace_id: "ws1", status: "pending" });
      }
      if (table.startsWith("rpc") || table === "fts_search_chunks" || table === "vector_search_chunks") {
        return send(res, 200, []);
      }
      return send(res, 201, single ? {} : []);
    }
    if (req.method === "PATCH" || req.method === "PUT" || req.method === "DELETE") {
      return send(res, 200, single ? {} : []);
    }
    return send(res, 200, single ? {} : []);
  }

  // RPC via /rest/v1/rpc/<fn>
  // (handled above as table "rpc"? actually path /rest/v1/rpc/fts_search_chunks)
  // Storage
  if (url.pathname.startsWith("/storage/v1/")) {
    return send(res, 200, { Key: "ws1/x.pdf" });
  }

  send(res, 404, { error: "not found", path: url.pathname });
});

server.listen(PORT, () => {
  console.log(`mock supabase listening on ${PORT}`);
});
