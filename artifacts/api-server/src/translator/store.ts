/**
 * In-memory job registry.
 *
 * Keeps translation jobs, allows querying by ID, and evicts old completed/cancelled jobs.
 */

import { TranslationJob } from "./engine";

const jobs = new Map<string, TranslationJob>();
const MAX_JOBS = 50;

export function registerJob(job: TranslationJob): void {
  if (jobs.size >= MAX_JOBS) {
    // Evict oldest finished job
    for (const [id, j] of jobs.entries()) {
      if (j.state === "complete" || j.state === "cancelled" || j.state === "failed") {
        jobs.delete(id);
        break;
      }
    }
  }
  jobs.set(job.id, job);
}

export function getJob(id: string): TranslationJob | undefined {
  return jobs.get(id);
}

export function deleteJob(id: string): boolean {
  const job = jobs.get(id);
  if (job) {
    job.cancel();
    return jobs.delete(id);
  }
  return false;
}
