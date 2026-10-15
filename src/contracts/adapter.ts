export const ADAPTER_CONTRACT_VERSION = 1 as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type AdapterDescriptor = {
  readonly id: string;
  readonly displayName: string;
  readonly contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  readonly adapterVersion: string;
  readonly schemaVersion: string;
};

export type AdapterCheckpoint = {
  readonly contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  readonly adapterVersion: string;
  readonly schemaVersion: string;
  readonly cursor: string | null;
};

export type IdentityCandidate = {
  readonly kind: string;
  readonly value: string | readonly string[];
};

export type SourceEvidence = {
  readonly format: string;
  readonly locator: string;
  readonly payload: JsonValue;
};

export type AdapterRecord = {
  readonly recordId: string;
  readonly updatedAt: string;
  readonly identity: IdentityCandidate | null;
  readonly comparable: JsonObject;
  readonly evidence: SourceEvidence;
  readonly deleted?: boolean;
};

export type ReadPageRequest = {
  readonly checkpoint: AdapterCheckpoint | null;
  readonly limit: number;
};

export type ReadPageResult = {
  readonly records: readonly AdapterRecord[];
  readonly nextCheckpoint: AdapterCheckpoint;
  readonly hasMore: boolean;
};

/**
 * Version 1 is intentionally read-only. Repair methods will arrive with the
 * controlled-repair milestone and will use a separate capability contract.
 */
export type ReadAdapter = {
  readonly descriptor: AdapterDescriptor;
  readPage(request: ReadPageRequest): Promise<ReadPageResult>;
};

export function createCheckpoint(
  descriptor: AdapterDescriptor,
  cursor: string | null,
): AdapterCheckpoint {
  return {
    contractVersion: ADAPTER_CONTRACT_VERSION,
    adapterVersion: descriptor.adapterVersion,
    schemaVersion: descriptor.schemaVersion,
    cursor,
  };
}

export function assertCheckpointCompatible(
  descriptor: AdapterDescriptor,
  checkpoint: AdapterCheckpoint | null,
): void {
  if (checkpoint === null) return;

  const rawCheckpoint: object = checkpoint;
  if (
    Reflect.get(rawCheckpoint, "contractVersion") !==
      descriptor.contractVersion ||
    Reflect.get(rawCheckpoint, "adapterVersion") !==
      descriptor.adapterVersion ||
    Reflect.get(rawCheckpoint, "schemaVersion") !== descriptor.schemaVersion
  ) {
    throw new Error(
      `${descriptor.id} checkpoint version does not match the active adapter and schema`,
    );
  }
}
