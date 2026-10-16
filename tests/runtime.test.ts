import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  HttpJsonAdapter,
  RetryableAdapterError,
  SqliteReconciliationStore,
  compare,
  verifyReadAdapter,
} from "../src/index.js";
import { withRetry } from "../src/core/runtime.js";

describe("bounded runtime", () => {
  it("times out a non-cooperative adapter and honors a retry hint", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const retries: number[] = [];
      const run = withRetry(
        () => {
          attempts++;
          if (attempts === 1)
            return new Promise<never>(() => {
              /* Deliberately never responds. */
            });
          if (attempts === 2)
            return Promise.reject(new RetryableAdapterError(50));
          return Promise.resolve("complete");
        },
        {
          policy: { timeoutMs: 10, backoffMs: 1 },
          onRetry: (attempt) => retries.push(attempt),
        },
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(49);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await run).toBe("complete");
      expect(retries).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels without waiting for a non-cooperative adapter", async () => {
    const controller = new AbortController();
    const run = withRetry(
      () =>
        new Promise<never>(() => {
          /* Deliberately ignores cancellation. */
        }),
      {
        signal: controller.signal,
      },
    );
    const assertion = expect(run).rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    await assertion;
  });

  it("exercises HTTP conformance, duplicate delivery, late updates, outage and 429 retries without leaking secrets", async () => {
    let faults = false;
    let calls = 0;
    const records = [
      {
        recordId: "one",
        identity: { kind: "sku", value: "one" },
        updatedAt: "2026-01-02T00:00:00Z",
        comparable: { stock: 12 },
        evidence: {
          format: "http.v1",
          locator: "one",
          payload: { secret: "fixture-secret" },
        },
      },
      {
        recordId: "one",
        identity: { kind: "sku", value: "one" },
        updatedAt: "2026-01-02T00:00:00Z",
        comparable: { stock: 12 },
        evidence: { format: "http.v1", locator: "duplicate", payload: {} },
      },
      {
        recordId: "one",
        identity: { kind: "sku", value: "one" },
        updatedAt: "2026-01-01T00:00:00Z",
        comparable: { stock: 99 },
        evidence: { format: "http.v1", locator: "late", payload: {} },
      },
    ];
    const server = createServer((req, res) => {
      if (faults && calls++ < 2) {
        res.writeHead(calls === 1 ? 429 : 503, { "retry-after": "0" });
        res.end("fixture-secret");
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const cursor = Number(url.searchParams.get("cursor"));
      const end = Math.min(
        records.length,
        cursor + Number(url.searchParams.get("limit")),
      );
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          records: records.slice(cursor, end),
          cursor: String(end),
          hasMore: end < records.length,
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No loopback port");
    const make = (id: string) =>
      new HttpJsonAdapter({
        id,
        datasetId: `loopback:${id}`,
        schemaVersion: "1",
        url: `http://127.0.0.1:${address.port}`,
      });
    const store = new SqliteReconciliationStore(":memory:");
    try {
      await verifyReadAdapter(() => make("contract"), 1);
      faults = true;
      const events: unknown[] = [];
      const report = await compare(
        {
          id: "http",
          source: make("source"),
          target: make("target"),
          pageSize: 1,
          runtime: { backoffMs: 0 },
        },
        { store, onEvent: (event) => events.push(event) },
      );
      expect(report.summary.equal).toBe(1);
      expect(
        events.filter(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "retry",
        ),
      ).toHaveLength(2);
      expect(JSON.stringify(events)).not.toContain("fixture-secret");
    } finally {
      store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
