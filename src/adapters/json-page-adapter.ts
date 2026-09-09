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
  expectArray,
  expectNumber,
  expectObject,
  expectString,
  optionalString,
  parseJson,
} from "./parsing.js";

type PagedRecord = {
  readonly page: number;
  readonly item: number;
  readonly value: JsonObject;
};

/** Reads Acme-style JSON pages and maps them to the version 1 read contract. */
export class JsonPageCommerceAdapter implements ReadAdapter {
  readonly descriptor: AdapterDescriptor;

  constructor(
    private readonly filePath: string,
    options: { readonly id?: string; readonly schemaVersion?: string } = {},
  ) {
    this.descriptor = {
      id: options.id ?? "local-acme-json",
      displayName: "Local Acme JSON pages",
      contractVersion: ADAPTER_CONTRACT_VERSION,
      adapterVersion: "json-pages.v1",
      schemaVersion: options.schemaVersion ?? "acme-orders.v1",
    };
  }

  async readPage(request: ReadPageRequest): Promise<ReadPageResult> {
    assertLimit(request.limit);
    assertCheckpointCompatible(this.descriptor, request.checkpoint);

    const document = expectObject(
      parseJson(await readFile(this.filePath, "utf8"), this.filePath),
      this.filePath,
    );
    const schemaVersion = expectString(
      document.schemaVersion,
      `${this.filePath}.schemaVersion`,
    );
    if (schemaVersion !== this.descriptor.schemaVersion) {
      throw new Error(
        `${this.descriptor.id} expected schema ${this.descriptor.schemaVersion}, received ${schemaVersion}`,
      );
    }

    const flattened = expectArray(
      document.pages,
      `${this.filePath}.pages`,
    ).flatMap((page, pageIndex) =>
      expectArray(page, `${this.filePath}.pages[${pageIndex}]`).map(
        (item, itemIndex): PagedRecord => ({
          page: pageIndex,
          item: itemIndex,
          value: expectObject(
            item,
            `${this.filePath}.pages[${pageIndex}][${itemIndex}]`,
          ),
        }),
      ),
    );
    const offset = parseCursor(request.checkpoint?.cursor);
    const selected = flattened.slice(offset, offset + request.limit);
    const nextOffset = offset + selected.length;

    return {
      records: selected.map((entry) => this.mapRecord(entry)),
      nextCheckpoint: createCheckpoint(this.descriptor, String(nextOffset)),
      hasMore: nextOffset < flattened.length,
    };
  }

  private mapRecord(entry: PagedRecord): AdapterRecord {
    const value = entry.value;
    const customer = expectObject(
      value.customer ?? {},
      `${this.filePath} customer`,
    );
    const orderNumber = optionalString(
      value.order_number,
      `${this.filePath} order_number`,
    );

    return {
      recordId: expectString(value.id, `${this.filePath} id`),
      updatedAt: expectString(
        value.modified_at,
        `${this.filePath} modified_at`,
      ),
      identity:
        orderNumber === null ? null : { kind: "order", value: orderNumber },
      comparable: {
        currency: expectString(
          value.currency_code,
          `${this.filePath} currency_code`,
        ),
        customerEmail: expectString(
          customer.email,
          `${this.filePath} customer.email`,
        ),
        status: expectString(value.status, `${this.filePath} status`),
        totalMinor: expectNumber(
          value.total_cents,
          `${this.filePath} total_cents`,
        ),
      },
      evidence: {
        format: "application/json",
        locator: `pages[${entry.page}][${entry.item}]`,
        payload: value,
      },
    };
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Page limit must be a positive integer");
  }
}

function parseCursor(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`Invalid JSON page cursor: ${cursor}`);
  }
  return offset;
}
