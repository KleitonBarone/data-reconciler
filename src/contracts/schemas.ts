// Draft 2020-12 schemas are data only. Runtime boundaries also validate semantic invariants.
const text = { type: "string", minLength: 1 };
const time = { ...text, format: "date-time" };
const count = { type: "integer", minimum: 0 };
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const ref = (name: string) => ({ $ref: "#/$defs/" + name });
const array = (items: object, limits: Record<string, unknown> = {}) => ({
  type: "array",
  items,
  ...limits,
});
const strings = { ...array(text), uniqueItems: true };
function object(
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) {
  return { type: "object", properties, required, additionalProperties: false };
}

const adapter = object(
  {
    id: text,
    displayName: text,
    contractVersion: { const: 1 },
    adapterVersion: text,
    schemaVersion: text,
    datasetId: text,
    readMode: { enum: ["snapshot", "incremental"] },
  },
  ["id", "displayName", "contractVersion", "adapterVersion", "schemaVersion"],
);
const checkpoint = object(
  {
    contractVersion: { const: 1 },
    adapterVersion: text,
    schemaVersion: text,
    cursor: nullable({ type: "string" }),
    datasetId: text,
    prefixHash: text,
  },
  ["contractVersion", "adapterVersion", "schemaVersion", "cursor"],
);
const jsonObject = { type: "object", additionalProperties: ref("json") };
const evidence = object({ format: text, locator: text, payload: ref("json") });
const snapshot = object(
  {
    side: { enum: ["source", "target"] },
    adapter: ref("adapter"),
    recordId: text,
    updatedAt: time,
    identityKey: nullable(text),
    comparable: jsonObject,
    evidence: ref("evidence"),
    normalizationVersion: text,
    deleted: { type: "boolean" },
    revision: text,
    revisionConflicts: array(ref("snapshot"), { maxItems: 1000 }),
  },
  [
    "side",
    "adapter",
    "recordId",
    "updatedAt",
    "identityKey",
    "comparable",
    "evidence",
    "normalizationVersion",
  ],
);
const compared = {
  oneOf: [
    object({ present: { const: false } }),
    object({ present: { const: true }, value: ref("json") }),
  ],
};
const difference = object({
  path: { type: "string" },
  source: compared,
  target: compared,
});
const owners = array(ref("snapshot"), { maxItems: 1000 });
const single = array(ref("snapshot"), { minItems: 1, maxItems: 1 });
const result = {
  oneOf: [
    object(
      {
        type: { const: "result" },
        classification: { const: "equal" },
        identityKey: text,
        source: single,
        target: single,
      },
      ["classification", "identityKey", "source", "target"],
    ),
    object(
      {
        type: { const: "result" },
        classification: { const: "missing" },
        identityKey: text,
        missingSide: { enum: ["source", "target"] },
        source: owners,
        target: owners,
      },
      ["classification", "identityKey", "missingSide", "source", "target"],
    ),
    object(
      {
        type: { const: "result" },
        classification: { const: "changed" },
        identityKey: text,
        newerSide: { enum: ["source", "target"] },
        differences: array(difference),
        source: single,
        target: single,
      },
      [
        "classification",
        "identityKey",
        "newerSide",
        "differences",
        "source",
        "target",
      ],
    ),
    object(
      {
        type: { const: "result" },
        classification: { const: "conflicting" },
        identityKey: nullable(text),
        reason: {
          enum: [
            "missing_identifier",
            "duplicate_identity",
            "ambiguous_ownership",
            "conflicting_revision",
            "deleted_record",
          ],
        },
        differences: array(difference),
        source: owners,
        target: owners,
      },
      [
        "classification",
        "identityKey",
        "reason",
        "differences",
        "source",
        "target",
      ],
    ),
  ],
};
const summary = object({
  total: count,
  equal: count,
  missing: count,
  changed: count,
  conflicting: count,
});
const ownership = object(
  {
    version: text,
    direction: { const: "source-to-target" },
    sourceFields: { ...strings, minItems: 1 },
    targetFields: strings,
    maxOperations: { type: "integer", minimum: 1, maximum: 1000 },
  },
  ["version", "direction", "sourceFields"],
);
const operation = object({
  id: digest,
  kind: { enum: ["create", "update"] },
  recordId: text,
  identityKey: text,
  identity: object({
    kind: text,
    value: { anyOf: [text, array(text, { minItems: 1 })] },
  }),
  expectedRevision: nullable(text),
  expectedCheckpoint: ref("checkpoint"),
  source: ref("snapshot"),
  before: nullable(ref("snapshot")),
  after: jsonObject,
  fields: { ...strings, minItems: 1 },
  deduplicationKey: text,
});
const receipt = object({
  recordId: text,
  revision: text,
  deduplicated: { type: "boolean" },
});
const definitions = {
  json: {
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      { type: "number" },
      { type: "string" },
      array(ref("json")),
      { type: "object", additionalProperties: ref("json") },
    ],
  },
  adapter,
  checkpoint,
  evidence,
  snapshot,
  result,
  summary,
  ownership,
  operation,
  receipt,
};
const reportProperties = {
  schemaVersion: { const: "1" },
  mode: { const: "dry-run" },
  jobId: text,
  fingerprint: text,
  runId: text,
  generatedAt: time,
  normalizationVersion: text,
  adapters: object({ source: ref("adapter"), target: ref("adapter") }),
  checkpoints: object({
    before: object({
      source: nullable(ref("checkpoint")),
      target: nullable(ref("checkpoint")),
    }),
    after: object({ source: ref("checkpoint"), target: ref("checkpoint") }),
  }),
  recordsRead: object({ source: count, target: count }),
  summary: ref("summary"),
  replay: object({
    jobId: text,
    from: { type: "integer", minimum: 1 },
    to: { type: "integer", minimum: 1 },
  }),
  results: array(ref("result")),
  observationsRead: array(ref("snapshot")),
};
const reportRequired = [
  "schemaVersion",
  "mode",
  "runId",
  "generatedAt",
  "normalizationVersion",
  "adapters",
  "checkpoints",
  "recordsRead",
  "summary",
];
const acceptance = object({
  schemaVersion: { const: "1" },
  digest,
  operationIds: { ...strings, minItems: 1, maxItems: 1000 },
  acceptedAt: time,
  expiresAt: time,
  allowedFields: { ...strings, minItems: 1 },
  maxOperations: { type: "integer", minimum: 1 },
  maxRecords: { type: "integer", minimum: 1 },
});
const outcome = object({
  schemaVersion: { const: "1" },
  digest,
  operationId: digest,
  state: { enum: ["pending", "succeeded", "skipped", "failed", "unknown"] },
  at: time,
  receipt: nullable(ref("receipt")),
  errorCode: nullable(text),
});
const applySummary = object({
  schemaVersion: { const: "1" },
  digest,
  jobId: text,
  attemptId: text,
  succeeded: count,
  skipped: count,
  failed: count,
  unknown: count,
  pending: count,
  cancelled: { type: "boolean" },
  verificationRunId: nullable(text),
});
function schema(body: object) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...body,
    $defs: definitions,
  };
}

/** Stable serialized contracts. Export with `data-reconciler schema --kind report`. */
export const schemas = {
  report: schema(object(reportProperties, [...reportRequired, "results"])),
  plan: schema(
    object({
      digest,
      body: object({
        schemaVersion: { const: "1" },
        jobId: text,
        fingerprint: text,
        runId: text,
        createdAt: time,
        expiresAt: time,
        policy: ref("ownership"),
        operations: array(ref("operation"), { maxItems: 1000 }),
        skipped: object({
          count,
          reasons: { type: "object", additionalProperties: count },
        }),
      }),
    }),
  ),
  acceptance: schema(acceptance),
  outcome: schema(outcome),
  applySummary: schema(applySummary),
  ndjson: schema({
    oneOf: [
      object({ ...reportProperties, type: { const: "run" } }, [
        ...reportRequired,
        "type",
      ]),
      {
        allOf: [
          ref("result"),
          {
            type: "object",
            properties: { type: { const: "result" } },
            required: ["type"],
          },
        ],
      },
      object({
        type: { const: "complete" },
        runId: text,
        summary: ref("summary"),
      }),
    ],
  }),
} as const;
