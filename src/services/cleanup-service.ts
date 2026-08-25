import type { Bindings } from "../bindings";
import type { FileRecord } from "../domain/file";
import { TEMP_OBJECT_PREFIX } from "../domain/storage";
import { getConfig } from "../env";
import { purgeExpiredAdminSessions } from "../repositories/admin-session-repository";
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
  readonly purgedAdminSessions: number;
}

export interface ReconcileResult {
  readonly missingObjects: number;
  readonly orphanObjects: number;
  readonly scannedFiles: number;
  readonly scannedObjects: number;
}

export async function runCleanup(
  env: Bindings,
  now = Math.floor(Date.now() / 1000),
): Promise<CleanupResult> {
  const config = getConfig(env);
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

  const reservations = await listExpiredReservations(env.DB, now, config.cleanupBatchLimit);
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

  const files = await listFilesForCleanup(env.DB, now, config.cleanupBatchLimit);
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

  const [purgedMetadata, purgedInvitationSessions, purgedAdminSessions] = await Promise.all([
    purgeDeletedMetadata(env.DB, now - config.deletedMetadataRetentionSeconds),
    purgeExpiredSessions(env.DB, now),
    purgeExpiredAdminSessions(env.DB, now),
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
      purgedAdminSessions,
    }),
  );

  return {
    scannedCount,
    deletedCount,
    failedCount,
    expiredReservations,
    purgedMetadata,
    purgedInvitationSessions,
    purgedAdminSessions,
  };
}

export async function reconcileStorage(
  env: Bindings,
  now = Math.floor(Date.now() / 1000),
): Promise<ReconcileResult> {
  const config = getConfig(env);
  const activeResult = await env.DB.prepare(
    `SELECT *
     FROM files
     WHERE status = 'active'
     ORDER BY created_at
     LIMIT ${config.reconcileMetadataLimit}`,
  ).all<FileRecord>();

  let missingObjects = 0;
  for (const file of activeResult.results) {
    if ((await env.FILES.head(file.object_key)) === null) {
      await markMissingObjectDeleted(env.DB, file, now);
      missingObjects += 1;
    }
  }

  const listed = await env.FILES.list({
    prefix: TEMP_OBJECT_PREFIX,
    limit: config.reconcileObjectLimit,
  });
  let orphanObjects = 0;
  for (const object of listed.objects) {
    if (object.uploaded.getTime() > (now - config.reconcileOrphanGraceSeconds) * 1000) {
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
