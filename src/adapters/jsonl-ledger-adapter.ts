import { readFile } from "node:fs/promises";
import {
  ADAPTER_CONTRACT_VERSION,
  assertCheckpointCompatible,
  createCheckpoint,
  type AdapterDescriptor,
  type AdapterRecord,
  type JsonObject,
  type ReadAdapter,
  type ReadPageRequest,
  type ReadPageResult,
} from "../contracts/adapter.js";
import {
  expectNumber,
  expectObject,
  expectString,
  optionalString,
  parseJson,
} from "./parsing.js";

type LedgerEntry = {
  readonly line: number;
  readonly value: JsonObject;
};

/** Reads a Northstar append-only JSONL ledger through its sequence cursor. */
export class JsonlLedgerCommerceAdapter implements ReadAdapter {
  readonly descriptor: AdapterDescriptor;

  constructor(
    private readonly filePath: string,
    options: { readonly id?: string; readonly schemaVersion?: string } = {},
  ) {
    this.descriptor = {
      id: options.id ?? "local-northstar-ledger",
      displayName: "Local Northstar JSONL ledger",
      contractVersion: ADAPTER_CONTRACT_VERSION,
      adapterVersion: "jsonl-ledger.v1",
      schemaVersion: options.schemaVersion ?? "northstar-orders.v1",
    };
  }

  async readPage(request: ReadPageRequest): Promise<ReadPageResult> {
    assertCheckpointCompatible(this.descriptor, request.checkpoint);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new Error("Page limit must be a positive integer");
    }

    const lines = (await readFile(this.filePath, "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const header = expectObject(
      parseJson(lines[0] ?? "null", `${this.filePath}:1`),
      `${this.filePath}:1`,
    );
    const schemaVersion = expectString(
      header.schemaVersion,
      `${this.filePath}:1 schemaVersion`,
    );
    if (
      header.type !== "schema" ||
      schemaVersion !== this.descriptor.schemaVersion
    ) {
      throw new Error(
        `${this.descriptor.id} expected schema ${this.descriptor.schemaVersion}, received ${schemaVersion}`,
      );
    }

    const afterSequence = parseCursor(request.checkpoint?.cursor);
    const entries = lines.slice(1).map((line, index): LedgerEntry => ({
      line: index + 2,
      value: expectObject(
        parseJson(line, `${this.filePath}:${index + 2}`),
        `${this.filePath}:${index + 2}`,
      ),
    }));
    const unread = entries.filter(
      (entry) =>
        expectNumber(
          entry.value.sequence,
          `${this.filePath}:${entry.line} sequence`,
        ) > afterSequence,
    );
    const selected = unread.slice(0, request.limit);
    const last = selected.at(-1);
    const nextSequence =
      last === undefined
        ? afterSequence
        : expectNumber(
            last.value.sequence,
            `${this.filePath}:${last.line} sequence`,
          );

    return {
      records: selected.map((entry) => this.mapRecord(entry)),
      nextCheckpoint: createCheckpoint(this.descriptor, String(nextSequence)),
      hasMore: selected.length < unread.length,
    };
  }

  private mapRecord(entry: LedgerEntry): AdapterRecord {
    const order = expectObject(
      entry.value.order ?? {},
      `${this.filePath}:${entry.line} order`,
    );
    const amount = expectObject(
      order.amount ?? {},
      `${this.filePath}:${entry.line} order.amount`,
    );
    const externalRef = optionalString(
      order.external_ref,
      `${this.filePath}:${entry.line} order.external_ref`,
    );

    return {
      recordId: expectString(
        order.local_id,
        `${this.filePath}:${entry.line} order.local_id`,
      ),
      updatedAt: expectString(
        order.last_seen,
        `${this.filePath}:${entry.line} order.last_seen`,
      ),
      identity:
        externalRef === null ? null : { kind: "order", value: externalRef },
      comparable: {
        currency: expectString(
          order.currency,
          `${this.filePath}:${entry.line} order.currency`,
        ),
        customerEmail: expectString(
          order.buyer_email,
          `${this.filePath}:${entry.line} order.buyer_email`,
        ),
        status: expectString(
          order.state,
          `${this.filePath}:${entry.line} order.state`,
        ),
        totalMinor: expectNumber(
          amount.minor,
          `${this.filePath}:${entry.line} order.amount.minor`,
        ),
      },
      evidence: {
        format: "application/x-ndjson",
        locator: `line:${entry.line}`,
        payload: entry.value,
      },
    };
  }
}

function parseCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined) return 0;
  const sequence = Number(cursor);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Invalid ledger cursor: ${cursor}`);
  }
  return sequence;
}
