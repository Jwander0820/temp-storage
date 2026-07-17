import type { Bindings } from "../bindings";
import type { FileRecord } from "../domain/file";
import {
  listFilesForCleanup,
  markMissingObjectDeleted,
  purgeDeletedMetadata,
} from "../repositories/file-repository";
import { purgeExpiredSessions } from "../repositories/invitation-repository";
import { listExpiredReservations, releaseReservation } from "../repositories/upload-repository";
import { deleteFileAsAdmin } from "./deletion-service";

export interface CleanupResult {
  readonly scannedCount: number;
  readonly deletedCount: number;
  readonly failedCount: number;
  readonly expiredReservations: number;
  readonly purgedMetadata: number;
  readonly purgedInvitationSessions: number;
}

export interface ReconcileResult {
  readonly missingObjects: number;
  readonly orphanObjects: number;
  readonly scannedFiles: number;
  readonly scannedObjects: number;
}

export async function runCleanup(
  env: Pick<Bindings, "DB" | "FILES">,
  now = Math.floor(Date.now() / 1000),
): Promise<CleanupResult> {
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO cleanup_runs (id, started_at, status)
     VALUES (?1, ?2, 'running')`,
  )
    .bind(runId, now)
    .run();

  let deletedCount = 0;
  let failedCount = 0;
  let expiredReservations = 0;

  console.log(JSON.stringify({ level: "info", event: "cleanup.started", runId }));

  const reservations = await listExpiredReservations(env.DB, now, 100);
  for (const reservation of reservations) {
    try {
      await releaseReservation(env.DB, reservation.id, now, "failed", "expired");
      expiredReservations += 1;
    } catch (error) {
      failedCount += 1;
      console.error(
        JSON.stringify({
          level: "error",
          event: "cleanup.reservation_failed",
          runId,
          reservationId: reservation.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const files = await listFilesForCleanup(env.DB, now, 100);
  const scannedCount = files.length;
  for (const file of files) {
    try {
      await deleteFileAsAdmin(env, file.id, now);
      deletedCount += 1;
    } catch (error) {
      failedCount += 1;
      console.error(
        JSON.stringify({
          level: "error",
          event: "cleanup.file_failed",
          runId,
          fileId: file.id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const [purgedMetadata, purgedInvitationSessions] = await Promise.all([
    purgeDeletedMetadata(env.DB, now - 604800),
    purgeExpiredSessions(env.DB, now),
  ]);
  const status = failedCount === 0 ? "completed" : deletedCount > 0 ? "partial" : "failed";
  await env.DB.prepare(
    `UPDATE cleanup_runs
     SET finished_at = ?1,
         scanned_count = ?2,
         deleted_count = ?3,
         failed_count = ?4,
         status = ?5
     WHERE id = ?6`,
  )
    .bind(now, scannedCount, deletedCount, failedCount, status, runId)
    .run();

  console.log(
    JSON.stringify({
      level: failedCount === 0 ? "info" : "error",
      event: failedCount === 0 ? "cleanup.completed" : "cleanup.failed",
      runId,
      scannedCount,
      deletedCount,
      failedCount,
      expiredReservations,
      purgedMetadata,
      purgedInvitationSessions,
    }),
  );

  return {
    scannedCount,
    deletedCount,
    failedCount,
    expiredReservations,
    purgedMetadata,
    purgedInvitationSessions,
  };
}

export async function reconcileStorage(
  env: Pick<Bindings, "DB" | "FILES">,
  now = Math.floor(Date.now() / 1000),
): Promise<ReconcileResult> {
  const activeResult = await env.DB.prepare(
    `SELECT *
     FROM files
     WHERE status = 'active'
     ORDER BY created_at
     LIMIT 500`,
  ).all<FileRecord>();

  let missingObjects = 0;
  for (const file of activeResult.results) {
    if ((await env.FILES.head(file.object_key)) === null) {
      await markMissingObjectDeleted(env.DB, file, now);
      missingObjects += 1;
    }
  }

  const listed = await env.FILES.list({ prefix: "objects/", limit: 1000 });
  let orphanObjects = 0;
  for (const object of listed.objects) {
    if (object.uploaded.getTime() > (now - 3600) * 1000) {
      continue;
    }
    const file = await env.DB.prepare("SELECT id FROM files WHERE object_key = ?1")
      .bind(object.key)
      .first<{ id: string }>();
    if (file === null) {
      await env.FILES.delete(object.key);
      orphanObjects += 1;
    }
  }

  console.log(
    JSON.stringify({
      level: "info",
      event: "quota.reconciled",
      missingObjects,
      orphanObjects,
      scannedFiles: activeResult.results.length,
      scannedObjects: listed.objects.length,
    }),
  );

  return {
    missingObjects,
    orphanObjects,
    scannedFiles: activeResult.results.length,
    scannedObjects: listed.objects.length,
  };
}
