import { compare, loadJob, SqliteReconciliationStore } from "data-reconciler";

const job = await loadJob(process.argv[2] ?? ".data/demo/job.json");
const store = new SqliteReconciliationStore(":memory:");
try {
  const report = await compare(job, { store });
  console.log(JSON.stringify(report.summary));
} finally {
  store.close();
}
