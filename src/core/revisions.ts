import type { RecordSnapshot } from "./model.js";
import { canonicalJson, compareText } from "./json.js";

/** Delivery order cannot supersede a newer revision or resolve an equal-time tie. */
export function mergeObservations(
  stored: readonly RecordSnapshot[],
  incoming: readonly RecordSnapshot[],
): readonly RecordSnapshot[] {
  const groups = new Map<string, RecordSnapshot[]>();
  for (const record of [...stored, ...incoming]) {
    const group = groups.get(record.recordId) ?? [];
    group.push(record, ...(record.revisionConflicts ?? []));
    groups.set(record.recordId, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, records]) => {
      const newest = records.reduce(
        (time, record) => Math.max(time, Date.parse(record.updatedAt)),
        -Infinity,
      );
      const variants = new Map<string, RecordSnapshot>();
      for (const record of records) {
        if (Date.parse(record.updatedAt) !== newest) continue;
        const snapshot = { ...record };
        delete snapshot.revisionConflicts;
        const signature = canonicalJson({
          identity: snapshot.identityKey,
          comparable: snapshot.comparable,
          deleted: snapshot.deleted ?? false,
        });
        // Deterministic evidence selection for identical repeated deliveries.
        const previous = variants.get(signature);
        if (
          previous === undefined ||
          canonicalJson(snapshot.evidence.payload) <
            canonicalJson(previous.evidence.payload)
        )
          variants.set(signature, snapshot);
      }
      const ordered = [...variants.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([, record]) => record);
      const [primary, ...conflicts] = ordered;
      if (primary === undefined)
        throw new Error("Revision group has no records");
      return conflicts.length === 0
        ? primary
        : { ...primary, revisionConflicts: conflicts };
    });
}
