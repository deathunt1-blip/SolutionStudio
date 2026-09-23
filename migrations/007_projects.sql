CREATE TABLE IF NOT EXISTS projects (
 id text PRIMARY KEY,organization_id text NOT NULL REFERENCES organizations(id),workspace_id text NOT NULL REFERENCES workspaces(id),
 name text NOT NULL,customer_name text,description text NOT NULL DEFAULT '',company_name text NOT NULL DEFAULT '上海青瞳视觉科技有限公司',
 document_type text NOT NULL DEFAULT 'technical_proposal',status text NOT NULL DEFAULT 'draft',context_revision integer NOT NULL DEFAULT 0,confirmed_revision integer,input_revision integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_scope ON projects(organization_id,workspace_id,updated_at);
CREATE TABLE IF NOT EXISTS project_inputs (
 id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),document_id text REFERENCES documents(id),kind text NOT NULL,
 filename text NOT NULL,title text NOT NULL,content_hash text NOT NULL,object_key text NOT NULL,mime_type text,status text NOT NULL DEFAULT 'ready',
 parsed_document jsonb,engineering_data jsonb,warnings jsonb NOT NULL DEFAULT '[]',error text,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,content_hash,kind)
);
CREATE TABLE IF NOT EXISTS project_assets (
 id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),input_id text NOT NULL REFERENCES project_inputs(id),
 role text NOT NULL,filename text NOT NULL,mime_type text NOT NULL,object_key text NOT NULL,width integer,height integer,caption text,source_ref jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS project_assets_owner ON project_assets(project_id,input_id);
CREATE TABLE IF NOT EXISTS project_facts (
 id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),key text NOT NULL,label text NOT NULL,value jsonb NOT NULL,unit text,
 source_type text NOT NULL,source_ref jsonb NOT NULL,locked boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(project_id,key,source_type)
);
CREATE TABLE IF NOT EXISTS project_requirements (
 id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),category text NOT NULL,source_input_id text REFERENCES project_inputs(id),
 source_chunk_id text REFERENCES knowledge_chunks(id),item jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_requirements_owner ON project_requirements(project_id);
CREATE TABLE IF NOT EXISTS project_context_snapshots (
 id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),revision integer NOT NULL,context jsonb NOT NULL,
 confirmed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(project_id,revision)
);
CREATE TABLE IF NOT EXISTS project_audit_events (
 id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id),action text NOT NULL,previous_value jsonb,next_value jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_project_scope ON documents(project_id,scope,status);
