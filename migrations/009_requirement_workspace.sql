CREATE TABLE project_manual_notes (id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,title text NOT NULL DEFAULT '',text text NOT NULL,status text NOT NULL DEFAULT 'active',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE project_requirement_decisions (id text PRIMARY KEY,project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,semantic_key text NOT NULL,decision jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(project_id,semantic_key));
CREATE TABLE project_clarification_answers (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,question_id text NOT NULL,answer jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,question_id));
ALTER TABLE projects ADD COLUMN fingerprint jsonb NOT NULL DEFAULT '{}';
CREATE INDEX project_manual_notes_owner ON project_manual_notes(project_id,status);
