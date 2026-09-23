CREATE TABLE IF NOT EXISTS external_connections (
 id text PRIMARY KEY, provider text NOT NULL, name text NOT NULL, app_id text NOT NULL,
 secret_ref text NOT NULL, status text NOT NULL DEFAULT 'error', last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_sync_jobs (
 id text PRIMARY KEY, source_id text NOT NULL REFERENCES knowledge_sources(id), status text NOT NULL DEFAULT 'queued',
 retry_failed boolean NOT NULL DEFAULT false, discovered integer NOT NULL DEFAULT 0,
 added integer NOT NULL DEFAULT 0, updated integer NOT NULL DEFAULT 0, unchanged integer NOT NULL DEFAULT 0,
 removed integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0, unsupported integer NOT NULL DEFAULT 0,
 errors jsonb NOT NULL DEFAULT '[]', started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS source_sync_one_active ON source_sync_jobs(source_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS source_resources (
 source_id text NOT NULL REFERENCES knowledge_sources(id), remote_id text NOT NULL, kind text NOT NULL,
 resource jsonb NOT NULL, document_id text REFERENCES documents(id), dataset_id text,
 content_hash text, remote_version text, status text NOT NULL, last_error text,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source_id,remote_id)
);
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '{}';
