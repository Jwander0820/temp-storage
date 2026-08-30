CREATE TABLE reconciliation_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT NOT NULL CHECK (phase IN ('metadata', 'objects')),
    file_created_at INTEGER,
    file_id TEXT,
    object_cursor TEXT,
    cycle_started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
        (phase = 'metadata' AND object_cursor IS NULL)
        OR (phase = 'objects' AND file_created_at IS NULL AND file_id IS NULL)
    ),
    CHECK (
        (file_created_at IS NULL AND file_id IS NULL)
        OR (file_created_at IS NOT NULL AND file_id IS NOT NULL)
    )
);
