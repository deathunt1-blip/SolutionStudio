CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS organizations (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), name text NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_sources (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), workspace_id text NOT NULL REFERENCES workspaces(id),
 type text NOT NULL, name text NOT NULL, mode text NOT NULL, source_of_truth text NOT NULL, config jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'ready'
);
CREATE TABLE IF NOT EXISTS source_documents (
 id text PRIMARY KEY, source_id text NOT NULL REFERENCES knowledge_sources(id), source_document_id text NOT NULL,
 source_path text, source_uri text, remote_version text, modified_at timestamptz, content_hash text NOT NULL,
 removed_from_source boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_documents_identity ON source_documents(source_id, source_document_id);
CREATE TABLE IF NOT EXISTS documents (
 id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), workspace_id text NOT NULL REFERENCES workspaces(id),
 scope text NOT NULL DEFAULT 'global' CHECK(scope IN ('global','workspace','project')), project_id text,
 source_document_id text NOT NULL REFERENCES source_documents(id), title text NOT NULL, title_user boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'uploaded', active_version_id text, user_overrides jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(scope <> 'project' OR project_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS document_versions (
 id text PRIMARY KEY, document_id text NOT NULL REFERENCES documents(id), version_number integer NOT NULL,
 filename text NOT NULL, mime_type text, content_hash text NOT NULL, object_key text NOT NULL, size_bytes bigint NOT NULL,
 status text NOT NULL DEFAULT 'active', summary text NOT NULL DEFAULT '', parsed_document jsonb,
 parse_status text NOT NULL DEFAULT 'pending', parse_warnings jsonb NOT NULL DEFAULT '[]', review_reasons jsonb NOT NULL DEFAULT '[]',
 error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(document_id,version_number)
);
CREATE INDEX IF NOT EXISTS document_versions_hash ON document_versions(content_hash);
CREATE INDEX IF NOT EXISTS documents_scope ON documents(organization_id,workspace_id,scope,status);
CREATE TABLE IF NOT EXISTS document_types (key text PRIMARY KEY, label text NOT NULL, aliases jsonb NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS applications (key text PRIMARY KEY, label text NOT NULL, aliases jsonb NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS topics (key text PRIMARY KEY, label text NOT NULL, aliases jsonb NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS classification_results (
 version_id text NOT NULL REFERENCES document_versions(id), field text NOT NULL, value jsonb NOT NULL,
 confidence double precision NOT NULL CHECK(confidence >= 0 AND confidence <= 1), source text NOT NULL, reasoning text,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(version_id,field)
);
CREATE TABLE IF NOT EXISTS document_applications (version_id text NOT NULL REFERENCES document_versions(id), application text NOT NULL, PRIMARY KEY(version_id,application));
CREATE TABLE IF NOT EXISTS document_topics (version_id text NOT NULL REFERENCES document_versions(id), topic text NOT NULL, PRIMARY KEY(version_id,topic));
CREATE TABLE IF NOT EXISTS document_products (version_id text NOT NULL REFERENCES document_versions(id), product text NOT NULL, PRIMARY KEY(version_id,product));
CREATE INDEX IF NOT EXISTS document_applications_value ON document_applications(application);
CREATE INDEX IF NOT EXISTS document_topics_value ON document_topics(topic);
CREATE INDEX IF NOT EXISTS document_products_value ON document_products(product);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
 id text PRIMARY KEY, document_id text NOT NULL REFERENCES documents(id), version_id text NOT NULL REFERENCES document_versions(id),
 chunk_order integer NOT NULL, heading_path jsonb NOT NULL DEFAULT '[]', text text NOT NULL, summary text NOT NULL DEFAULT '',
 topics jsonb NOT NULL DEFAULT '[]', products jsonb NOT NULL DEFAULT '[]', metadata jsonb NOT NULL DEFAULT '{}',
 search_vector tsvector, embedding_status text NOT NULL DEFAULT 'not_configured', UNIQUE(version_id,chunk_order)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_fts ON knowledge_chunks USING gin(search_vector);
CREATE INDEX IF NOT EXISTS knowledge_chunks_version ON knowledge_chunks(version_id);
CREATE TABLE IF NOT EXISTS chunk_embeddings (chunk_id text NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE, provider text NOT NULL, model text NOT NULL, dimensions integer NOT NULL, vector_data double precision[], PRIMARY KEY(chunk_id,provider,model));
CREATE TABLE IF NOT EXISTS confirmed_examples (
 id text PRIMARY KEY, organization_id text NOT NULL, workspace_id text NOT NULL, scope text NOT NULL DEFAULT 'global', project_id text,
 document_id text NOT NULL REFERENCES documents(id), version_id text NOT NULL REFERENCES document_versions(id), text_summary text NOT NULL,
 confirmed_fields jsonb NOT NULL, search_vector tsvector, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS confirmed_examples_fts ON confirmed_examples USING gin(search_vector);
CREATE TABLE IF NOT EXISTS extracted_facts (
 id text PRIMARY KEY, document_id text NOT NULL REFERENCES documents(id), version_id text NOT NULL REFERENCES document_versions(id),
 chunk_id text NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE, product text NOT NULL, field text NOT NULL, value text NOT NULL,
 evidence_text text NOT NULL, confidence double precision NOT NULL, authority text NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_conflicts (
 id text PRIMARY KEY, organization_id text NOT NULL, workspace_id text NOT NULL, scope text NOT NULL DEFAULT 'global', project_id text,
 product text NOT NULL, field text NOT NULL, first_fact_id text REFERENCES extracted_facts(id) ON DELETE SET NULL,
 second_fact_id text REFERENCES extracted_facts(id) ON DELETE SET NULL, status text NOT NULL DEFAULT 'unresolved',
 resolution_policy text NOT NULL DEFAULT 'authoritative_precedence', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ingestion_jobs (
 id text PRIMARY KEY, document_id text NOT NULL REFERENCES documents(id), version_id text NOT NULL REFERENCES document_versions(id),
 status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_pending ON ingestion_jobs(version_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS audit_events (
 id text PRIMARY KEY, document_id text NOT NULL REFERENCES documents(id), version_id text REFERENCES document_versions(id),
 action text NOT NULL, modified_by text NOT NULL DEFAULT 'local-user', previous_value jsonb, next_value jsonb, modified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
