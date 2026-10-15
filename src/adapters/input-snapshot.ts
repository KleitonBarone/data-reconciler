import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AdapterCheckpoint, JsonValue } from "../contracts/adapter.js";
import { canonicalJson } from "../core/json.js";
import { ReconciliationError } from "../core/errors.js";

/** Local inputs are bounded snapshots; a new adapter instance observes a new run. */
export class InputSnapshot {
  readonly datasetId: string;
  private cached: Promise<{ text: string; signature: string }> | undefined;
  constructor(private readonly path: string) {
    this.datasetId = resolve(path);
  }
  async text(): Promise<string> {
    const info = await stat(this.path);
    if (info.size > 32 * 1024 * 1024)
      throw new ReconciliationError(
        "limit_exceeded",
        "Local input exceeds the 32 MiB snapshot limit",
      );
    const signature = `${info.size}:${info.mtimeMs}:${info.ino}`;
    this.cached ??= readFile(this.path, "utf8").then((text) => ({
      text,
      signature,
    }));
    const snapshot = await this.cached;
    if (signature !== snapshot.signature)
      throw new ReconciliationError(
        "incompatible_state",
        "Input changed during a read; create a new adapter and rescan explicitly",
      );
    return snapshot.text;
  }
}

export function prefixHashes(records: readonly JsonValue[]): readonly string[] {
  const hash = createHash("sha256");
  const prefixes = [hash.copy().digest("hex")];
  for (const record of records) {
    hash.update(canonicalJson(record)).update("\n");
    prefixes.push(hash.copy().digest("hex"));
  }
  return prefixes;
}

export function validatePrefix(
  checkpoint: AdapterCheckpoint | null,
  datasetId: string,
  prefix: string | undefined,
): void {
  if (checkpoint === null) return;
  if (
    prefix === undefined ||
    checkpoint.datasetId !== datasetId ||
    checkpoint.prefixHash !== prefix
  ) {
    throw new ReconciliationError(
      "incompatible_state",
      "Input was replaced, reordered, or truncated. Use a new state generation for an explicit rescan.",
    );
  }
}
