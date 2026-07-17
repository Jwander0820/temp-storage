PRAGMA foreign_keys = ON;

CREATE TABLE files (
    id TEXT PRIMARY KEY,
    object_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    extension TEXT,
    declared_mime TEXT,
    detected_mime TEXT,
    size_bytes INTEGER NOT NULL,
    preview_policy TEXT CHECK (
        preview_policy IS NULL
        OR preview_policy IN ('inline', 'download_only', 'blocked')
    ),
    status TEXT NOT NULL CHECK (
        status IN (
            'reserved',
            'uploading',
            'active',
            'deleting',
            'deleted',
            'rejected',
            'failed'
        )
    ),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    deleted_at INTEGER,
    delete_token_hash TEXT,
    uploader_hash TEXT,
    sha256 TEXT,
    CHECK (size_bytes >= 0),
    CHECK (
        status != 'active'
        OR (
            detected_mime IS NOT NULL
            AND preview_policy IN ('inline', 'download_only')
            AND delete_token_hash IS NOT NULL
        )
    )
);

CREATE TABLE upload_reservations (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL UNIQUE,
    reserved_bytes INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('reserved', 'consumed', 'expired', 'cancelled')
    ),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    quota_released_at INTEGER,
    FOREIGN KEY(file_id) REFERENCES files(id),
    CHECK (reserved_bytes > 0)
);

CREATE TABLE storage_usage (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    used_bytes INTEGER NOT NULL DEFAULT 0,
    reserved_bytes INTEGER NOT NULL DEFAULT 0,
    max_bytes INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (used_bytes >= 0),
    CHECK (reserved_bytes >= 0),
    CHECK (max_bytes > 0)
);

INSERT INTO storage_usage (
    id,
    used_bytes,
    reserved_bytes,
    max_bytes,
    updated_at
)
VALUES (
    1,
    0,
    0,
    3221225472,
    unixepoch()
);

CREATE TABLE cleanup_runs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    scanned_count INTEGER NOT NULL DEFAULT 0,
    deleted_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (
        status IN ('running', 'completed', 'partial', 'failed')
    ),
    error_message TEXT
);

CREATE TABLE rate_limit_events (
    id TEXT PRIMARY KEY,
    uploader_hash TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (size_bytes > 0)
);
