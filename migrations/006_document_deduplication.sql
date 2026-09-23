-- Deduplication is logical: original documents, versions, files and provenance remain intact.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS canonical_document_id text REFERENCES documents(id);
ALTER TABLE documents ADD CONSTRAINT documents_canonical_not_self CHECK(canonical_document_id IS NULL OR canonical_document_id <> id);
CREATE INDEX IF NOT EXISTS documents_canonical ON documents(canonical_document_id);
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS normalized_content_hash text;
CREATE INDEX IF NOT EXISTS document_versions_normalized_hash ON document_versions(normalized_content_hash) WHERE normalized_content_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_source_references (
 id text PRIMARY KEY, document_id text NOT NULL REFERENCES documents(id),
 source_id text NOT NULL REFERENCES knowledge_sources(id), source_document_id text NOT NULL,
 source_path text, source_url text, remote_version text, filename text NOT NULL,
 content_hash text NOT NULL, object_key text NOT NULL, source_metadata jsonb NOT NULL DEFAULT '{}',
 discovered_at timestamptz NOT NULL DEFAULT now(), removed boolean NOT NULL DEFAULT false,
 UNIQUE(source_id,source_document_id,document_id,content_hash)
);
CREATE INDEX IF NOT EXISTS document_sources_document ON document_source_references(document_id);
CREATE INDEX IF NOT EXISTS document_sources_identity ON document_source_references(source_id,source_document_id);
INSERT INTO document_source_references(id,document_id,source_id,source_document_id,source_path,source_url,remote_version,filename,content_hash,object_key,source_metadata,discovered_at,removed)
 SELECT 'primary:' || d.id,d.id,s.source_id,s.source_document_id,s.source_path,s.source_uri,s.remote_version,v.filename,v.content_hash,v.object_key,v.source_metadata,s.created_at,s.removed_from_source
 FROM documents d JOIN source_documents s ON s.id=d.source_document_id JOIN document_versions v ON v.id=d.active_version_id
 ON CONFLICT DO NOTHING;

-- Exact/content hash cohorts may have many members; near/version suggestions are pairs.
-- Similarity is not transitive, so A≈B and B≈C do not imply A≈C.
CREATE TABLE IF NOT EXISTS document_duplicate_groups (
 id text PRIMARY KEY, pair_key text NOT NULL UNIQUE, canonical_document_id text NOT NULL REFERENCES documents(id),
 relation text NOT NULL CHECK(relation IN ('exact_duplicate','content_duplicate','near_duplicate','possible_version','similar')),
 status text NOT NULL DEFAULT 'suggested' CHECK(status IN ('suggested','confirmed','dismissed')),
 score double precision NOT NULL CHECK(score>=0 AND score<=1), reasons jsonb NOT NULL DEFAULT '[]', differences jsonb NOT NULL DEFAULT '[]',
 operation text CHECK(operation IN ('merge','version')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS duplicate_groups_status ON document_duplicate_groups(status,relation);
CREATE TABLE IF NOT EXISTS document_duplicate_members (
 group_id text NOT NULL REFERENCES document_duplicate_groups(id), document_id text NOT NULL REFERENCES documents(id),
 version_id text NOT NULL REFERENCES document_versions(id), PRIMARY KEY(group_id,document_id)
);
CREATE INDEX IF NOT EXISTS duplicate_members_document ON document_duplicate_members(document_id);
CREATE TABLE IF NOT EXISTS document_version_groups (
 id text PRIMARY KEY, duplicate_group_id text NOT NULL UNIQUE REFERENCES document_duplicate_groups(id),
 canonical_document_id text NOT NULL REFERENCES documents(id), status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','undone')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS document_version_members (
 group_id text NOT NULL REFERENCES document_version_groups(id), document_id text NOT NULL REFERENCES documents(id),
 version_id text NOT NULL REFERENCES document_versions(id), detected_version text, detected_date text, similarity double precision NOT NULL,
 PRIMARY KEY(group_id,document_id)
);
CREATE TABLE IF NOT EXISTS dedup_operations (
 id text PRIMARY KEY, group_id text NOT NULL REFERENCES document_duplicate_groups(id),
 kind text NOT NULL CHECK(kind IN ('merge','version')), before_snapshot jsonb NOT NULL, after_snapshot jsonb NOT NULL,
 undone_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS dedup_operation_active ON dedup_operations(group_id) WHERE undone_at IS NULL;
