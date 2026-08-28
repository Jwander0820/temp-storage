import type { Bindings } from "../bindings";
import { DomainError } from "../domain/errors";
import { TEMP_OBJECT_PREFIX } from "../domain/storage";
import { getConfig } from "../env";
import { purgeExpiredAdminSessions } from "../repositories/admin-session-repository";
import {
  hasFileMetadataForObject,
  listActiveFilesForReconciliation,
  listFilesForCleanup,
  markMissingObjectDeleted,
  purgeDeletedMetadata,
  purgeFailedUploadMetadata,
} from "../repositories/file-repository";
import {
  purgeExpiredSessions,
  purgeRetiredInvitationHistory,
} from "../repositories/invitation-repository";
import { listExpiredReservations, releaseReservation } from "../repositories/upload-repository";
import { deleteFileAsAdmin } from "./deletion-service";

export interface CleanupResult {
  readonly scannedCount: number;
  readonly deletedCount: number;
  readonly failedCount: number;
  readonly expiredReservations: number;
  readonly purgedMetadata: number;
  readonly purgedFailedUploads: number;
  readonly purgedInvitationSessions: number;
  readonly purgedAdminSessions: number;
  readonly purgedCleanupRuns: number;
  readonly purgedInvitationHistory: number;
}

export interface ReconcileResult {
  readonly missingObjects: number;
  readonly orphanObjects: number;
  readonly scannedFiles: number;
  readonly scannedObjects: number;
}

async function purgeCleanupRunHistory(
  database: D1Database,
  cutoff: number,
  limit: number,
): Promise<number> {
  const result = await database
    .prepare(
      `DELETE FROM cleanup_runs
       WHERE id IN (
         SELECT id
         FROM cleanup_runs
         WHERE status != 'running'
           AND finished_at <= ?1
         ORDER BY finished_at, id
         LIMIT ?2
       )`,
    )
    .bind(cutoff, limit)
    .run();
  return typeof result.meta.changes === "number" ? result.meta.changes : 0;
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

  const [purgedMetadata, purgedFailedUploads, purgedInvitationSessions, purgedAdminSessions] =
    await Promise.all([
      purgeDeletedMetadata(
        env.DB,
        now - config.deletedMetadataRetentionSeconds,
        config.cleanupBatchLimit,
      ),
      purgeFailedUploadMetadata(
        env.DB,
        now - config.failedUploadMetadataRetentionSeconds,
        config.cleanupBatchLimit,
      ),
      purgeExpiredSessions(env.DB, now),
      purgeExpiredAdminSessions(env.DB, now),
    ]);
  const [purgedCleanupRuns, purgedInvitationHistory] = await Promise.all([
    purgeCleanupRunHistory(
      env.DB,
      now - config.cleanupRunRetentionSeconds,
      config.cleanupBatchLimit,
    ),
    purgeRetiredInvitationHistory(
      env.DB,
      now - config.invitationHistoryRetentionSeconds,
      config.cleanupBatchLimit,
    ),
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
      purgedFailedUploads,
      purgedInvitationSessions,
      purgedAdminSessions,
      purgedCleanupRuns,
      purgedInvitationHistory,
    }),
  );

  return {
    scannedCount,
    deletedCount,
    failedCount,
    expiredReservations,
    purgedMetadata,
    purgedFailedUploads,
    purgedInvitationSessions,
    purgedAdminSessions,
    purgedCleanupRuns,
    purgedInvitationHistory,
  };
}

export async function reconcileStorage(
  env: Bindings,
  now = Math.floor(Date.now() / 1000),
): Promise<ReconcileResult> {
  const config = getConfig(env);
  let missingObjects = 0;
  let scannedFiles = 0;
  let fileCursor: { createdAt: number; id: string } | null = null;
  while (true) {
    const files = await listActiveFilesForReconciliation(
      env.DB,
      fileCursor,
      config.reconcileMetadataLimit,
    );
    if (files.length === 0) {
      break;
    }
    scannedFiles += files.length;
    for (const file of files) {
      if ((await env.FILES.head(file.object_key)) === null) {
        await markMissingObjectDeleted(env.DB, file, now);
        missingObjects += 1;
      }
    }
    const lastFile = files.at(-1);
    if (lastFile === undefined) {
      break;
    }
    fileCursor = { createdAt: lastFile.created_at, id: lastFile.id };
  }

  let orphanObjects = 0;
  let scannedObjects = 0;
  let objectCursor: string | undefined;
  while (true) {
    const listed = await env.FILES.list({
      prefix: TEMP_OBJECT_PREFIX,
      limit: config.reconcileObjectLimit,
      ...(objectCursor === undefined ? {} : { cursor: objectCursor }),
    });
    scannedObjects += listed.objects.length;
    for (const object of listed.objects) {
      if (object.uploaded.getTime() > (now - config.reconcileOrphanGraceSeconds) * 1000) {
        continue;
      }
      if (!(await hasFileMetadataForObject(env.DB, object.key))) {
        await env.FILES.delete(object.key);
        orphanObjects += 1;
      }
    }
    if (!listed.truncated) {
      break;
    }
    if (listed.cursor === undefined || listed.cursor === objectCursor) {
      throw new DomainError("INTERNAL_ERROR", 500, "R2 reconciliation cursor did not advance.");
    }
    objectCursor = listed.cursor;
  }

  console.log(
    JSON.stringify({
      level: "info",
      event: "quota.reconciled",
      missingObjects,
      orphanObjects,
      scannedFiles,
      scannedObjects,
    }),
  );

  return {
    missingObjects,
    orphanObjects,
    scannedFiles,
    scannedObjects,
  };
}
