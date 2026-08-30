export interface ReconcileStateRow {
  readonly phase: "metadata" | "objects";
  readonly file_created_at: number | null;
  readonly file_id: string | null;
  readonly object_cursor: string | null;
}

export async function loadReconcileState(
  database: D1Database,
  now: number,
): Promise<ReconcileStateRow | null> {
  await database
    .prepare(
      `INSERT OR IGNORE INTO reconciliation_state (
         id, phase, cycle_started_at, updated_at
       ) VALUES (1, 'metadata', ?1, ?1)`,
    )
    .bind(now)
    .run();
  return database
    .prepare(
      `SELECT phase, file_created_at, file_id, object_cursor
       FROM reconciliation_state
       WHERE id = 1`,
    )
    .first<ReconcileStateRow>();
}

export async function saveReconcileState(
  database: D1Database,
  state: ReconcileStateRow,
  now: number,
): Promise<void> {
  await database
    .prepare(
      `UPDATE reconciliation_state
       SET phase = ?1,
           file_created_at = ?2,
           file_id = ?3,
           object_cursor = ?4,
           updated_at = ?5
       WHERE id = 1`,
    )
    .bind(state.phase, state.file_created_at, state.file_id, state.object_cursor, now)
    .run();
}

export async function resetReconcileState(database: D1Database): Promise<void> {
  await database.prepare("DELETE FROM reconciliation_state WHERE id = 1").run();
}
