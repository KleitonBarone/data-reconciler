import type {
  AdapterCheckpoint,
  AdapterDescriptor,
  JsonObject,
  JsonValue,
  SourceEvidence,
} from "../contracts/adapter.js";

export const NORMALIZATION_VERSION = "json.v1";
export const REPORT_SCHEMA_VERSION = "1";

export type Side = "source" | "target";

export type RecordSnapshot = {
  readonly side: Side;
  readonly adapter: AdapterDescriptor;
  readonly recordId: string;
  readonly updatedAt: string;
  readonly identityKey: string | null;
  readonly comparable: JsonObject;
  readonly evidence: SourceEvidence;
  readonly normalizationVersion: string;
  readonly deleted?: boolean;
  readonly revision?: string;
  readonly revisionConflicts?: readonly RecordSnapshot[];
};

export type FieldDifference = {
  readonly path: string;
  readonly source: ComparedValue;
  readonly target: ComparedValue;
};

export type ComparedValue =
  | { readonly present: false }
  | { readonly present: true; readonly value: JsonValue };

export type EqualResult = {
  readonly classification: "equal";
  readonly identityKey: string;
  readonly source: readonly [RecordSnapshot];
  readonly target: readonly [RecordSnapshot];
};

export type MissingResult = {
  readonly classification: "missing";
  readonly identityKey: string;
  readonly missingSide: Side;
  readonly source: readonly RecordSnapshot[];
  readonly target: readonly RecordSnapshot[];
};

export type ChangedResult = {
  readonly classification: "changed";
  readonly identityKey: string;
  readonly newerSide: Side;
  readonly differences: readonly FieldDifference[];
  readonly source: readonly [RecordSnapshot];
  readonly target: readonly [RecordSnapshot];
};

export type ConflictReason =
  | "ambiguous_ownership"
  | "duplicate_identity"
  | "missing_identifier"
  | "conflicting_revision"
  | "deleted_record";

export type ConflictingResult = {
  readonly classification: "conflicting";
  readonly identityKey: string | null;
  readonly reason: ConflictReason;
  readonly differences: readonly FieldDifference[];
  readonly source: readonly RecordSnapshot[];
  readonly target: readonly RecordSnapshot[];
};

export type ReconciliationResult =
  EqualResult | MissingResult | ChangedResult | ConflictingResult;

export type ReportSummary = {
  readonly total: number;
  readonly equal: number;
  readonly missing: number;
  readonly changed: number;
  readonly conflicting: number;
};

export type ReconciliationReport = {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly runId: string;
  readonly generatedAt: string;
  readonly mode: "dry-run";
  readonly normalizationVersion: string;
  readonly adapters: {
    readonly source: AdapterDescriptor;
    readonly target: AdapterDescriptor;
  };
  readonly checkpoints: {
    readonly before: {
      readonly source: AdapterCheckpoint | null;
      readonly target: AdapterCheckpoint | null;
    };
    readonly after: {
      readonly source: AdapterCheckpoint;
      readonly target: AdapterCheckpoint;
    };
  };
  readonly recordsRead: {
    readonly source: number;
    readonly target: number;
  };
  readonly summary: ReportSummary;
  readonly results: readonly ReconciliationResult[];
  readonly observationsRead: readonly RecordSnapshot[];
};
