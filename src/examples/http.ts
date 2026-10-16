import { createServer } from "node:http";
import { once } from "node:events";
import {
  HttpJsonAdapter,
  compare,
  SqliteReconciliationStore,
} from "../index.js";

let requests = 0;
const server = createServer((req, res) => {
  if (++requests === 1) {
    res.writeHead(429, { "retry-after": "0" });
    res.end();
    return;
  }
  const cursor = new URL(req.url ?? "/", "http://localhost").searchParams.get(
    "cursor",
  );
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      records:
        cursor === "0"
          ? [
              {
                recordId: "shirt",
                updatedAt: "2026-01-01T00:00:00Z",
                identity: { kind: "sku", value: "shirt" },
                comparable: { stock: 12 },
                evidence: {
                  format: "http.v1",
                  locator: "/inventory/shirt",
                  payload: { stock: 12 },
                },
              },
            ]
          : [],
      cursor: "1",
      hasMore: false,
    }),
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (address === null || typeof address === "string")
  throw new Error("No loopback port");
const adapter = (id: string) =>
  new HttpJsonAdapter({
    id,
    datasetId: `fixture:${id}`,
    schemaVersion: "http.v1",
    url: `http://127.0.0.1:${address.port}`,
  });
const store = new SqliteReconciliationStore(":memory:");
try {
  const report = await compare(
    { id: "http-worker", source: adapter("source"), target: adapter("target") },
    { store },
  );
  console.log(JSON.stringify(report.summary));
} finally {
  store.close();
  server.closeAllConnections();
  server.close();
}
