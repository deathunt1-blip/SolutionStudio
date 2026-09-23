CREATE TABLE IF NOT EXISTS structured_datasets (
 id text PRIMARY KEY, source_id text NOT NULL, remote_id text NOT NULL,
 title text NOT NULL, summary text NOT NULL DEFAULT '', source_type text NOT NULL DEFAULT 'structured',
 status text NOT NULL CHECK(status IN ('pending_mapping','active','removed')),
 raw_data jsonb NOT NULL, schema_fields jsonb NOT NULL DEFAULT '[]', mapping jsonb,
 records jsonb NOT NULL DEFAULT '[]', warnings jsonb NOT NULL DEFAULT '[]',
 version integer NOT NULL DEFAULT 1, content_hash text NOT NULL, remote_version text,
 modified_at text, synced_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,remote_id)
);
CREATE TABLE IF NOT EXISTS structured_dataset_versions (
 dataset_id text NOT NULL REFERENCES structured_datasets(id), version integer NOT NULL,
 source_revision text, synced_at timestamptz NOT NULL, reason text NOT NULL,
 snapshot jsonb NOT NULL, PRIMARY KEY(dataset_id,version)
);
CREATE TABLE IF NOT EXISTS structured_facts (
 id text PRIMARY KEY, source_dataset_id text NOT NULL REFERENCES structured_datasets(id),
 source_record_id text NOT NULL, product_key text NOT NULL, field text NOT NULL,
 value jsonb NOT NULL, unit text, authority text NOT NULL CHECK(authority IN ('reference','authoritative')),
 source_ref jsonb NOT NULL, active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL,
 UNIQUE(source_dataset_id,source_record_id,field)
);
CREATE INDEX IF NOT EXISTS structured_facts_active ON structured_facts(product_key,source_dataset_id) WHERE active;
CREATE TABLE IF NOT EXISTS structured_fact_history (
 id text PRIMARY KEY, fact_id text NOT NULL, dataset_id text NOT NULL REFERENCES structured_datasets(id),
 source_record_id text NOT NULL, product_key text NOT NULL, field text NOT NULL,
 before_value jsonb, after_value jsonb, source_ref jsonb NOT NULL,
 source_revision text, synced_at timestamptz NOT NULL, reason text NOT NULL
);
CREATE INDEX IF NOT EXISTS structured_fact_history_dataset ON structured_fact_history(dataset_id,synced_at);
