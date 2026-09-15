BEGIN;
CREATE TABLE IF NOT EXISTS deployment_settings(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),region text NOT NULL CHECK(region IN ('CN','HK')));
ALTER TABLE deployment_settings ADD COLUMN IF NOT EXISTS mode text CHECK(mode IN ('demo','service'));
CREATE TABLE IF NOT EXISTS users(
 id uuid PRIMARY KEY, region text NOT NULL CHECK(region IN ('CN','HK')), username text UNIQUE NOT NULL, name text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','staff','parent','student','teacher')), password_hash text,
 demo boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,region text NOT NULL,expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS login_attempts(key_hash text PRIMARY KEY,attempts integer NOT NULL DEFAULT 0,window_started timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS families(
 id uuid PRIMARY KEY,region text NOT NULL,family_name text NOT NULL,child_name text NOT NULL,birth_date date NOT NULL,grade text NOT NULL,
 guardian_label text NOT NULL,assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships(family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,role text NOT NULL CHECK(role IN ('parent','student','teacher')),PRIMARY KEY(family_id,user_id));
CREATE INDEX IF NOT EXISTS membership_users ON memberships(user_id);
CREATE TABLE IF NOT EXISTS consents(
 id uuid PRIMARY KEY,family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
 guardian_name text NOT NULL,method text NOT NULL CHECK(method IN ('online_guardian','offline_signed','synthetic')),reference text,
 notice_version text NOT NULL,scopes jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz
);
WITH ranked AS(SELECT id,row_number() OVER(PARTITION BY family_id ORDER BY created_at DESC,id DESC) AS n FROM consents WHERE revoked_at IS NULL)
UPDATE consents SET revoked_at=now() FROM ranked WHERE consents.id=ranked.id AND ranked.n>1;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_family_consent ON consents(family_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS invitations(token_hash text PRIMARY KEY,family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,role text NOT NULL CHECK(role IN ('parent','student','teacher')),expires_at timestamptz NOT NULL,used_at timestamptz,created_by uuid REFERENCES users(id));
-- Single-use links that let an EXISTING account set a new password. Issued by an
-- administrator and shown once; never emailed automatically, matching invitations.
-- Accepting one also ends every session for that account.
CREATE TABLE IF NOT EXISTS recovery_tokens(
 token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 region text NOT NULL CHECK(region IN ('CN','HK')),expires_at timestamptz NOT NULL,used_at timestamptz,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS recovery_expiry ON recovery_tokens(expires_at);
CREATE TABLE IF NOT EXISTS scales(id text PRIMARY KEY,scale_id text NOT NULL,version text NOT NULL,definition jsonb NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(scale_id,version));
CREATE TABLE IF NOT EXISTS content_versions(id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('advice','template')),version text NOT NULL,content jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(kind,version));
CREATE TABLE IF NOT EXISTS assessments(
 id uuid PRIMARY KEY,family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,region text NOT NULL,respondent_id uuid NOT NULL REFERENCES users(id),
 respondent_role text NOT NULL CHECK(respondent_role IN ('parent','student','teacher')),scale_version_id text NOT NULL REFERENCES scales(id),locale text NOT NULL CHECK(locale IN ('zh-CN','zh-HK')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','published','failed')),draft_answers jsonb NOT NULL DEFAULT '{}',
 answers jsonb,snapshot jsonb,created_at timestamptz NOT NULL DEFAULT now(),submitted_at timestamptz,acknowledged_at timestamptz
);
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS draft_revision integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_assessment ON assessments(family_id,respondent_id,scale_version_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS assessments_family ON assessments(family_id,submitted_at);
CREATE TABLE IF NOT EXISTS report_jobs(
 id uuid PRIMARY KEY,assessment_id uuid UNIQUE NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','running','done','failed')),
 attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,claim_token uuid,last_error_code text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reports(
 id uuid PRIMARY KEY,assessment_id uuid UNIQUE NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
 region text NOT NULL,payload jsonb NOT NULL,pdf_keys jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS html_documents jsonb;
UPDATE deployment_settings SET mode=CASE WHEN EXISTS(SELECT 1 FROM users WHERE demo) THEN 'demo' ELSE 'service' END WHERE mode IS NULL;
CREATE TABLE IF NOT EXISTS goals(id uuid PRIMARY KEY,family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,title text NOT NULL,detail text NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed')),created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS observations(id uuid PRIMARY KEY,family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,body text NOT NULL,created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_events(id bigserial PRIMARY KEY,region text NOT NULL,actor_id uuid,action text NOT NULL,entity_id text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS file_deletion_jobs(file_key text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
-- One row per region. The report worker refreshes it every few seconds so that
-- "is the report pipeline actually running?" is answerable without inspecting hosts.
CREATE TABLE IF NOT EXISTS worker_heartbeats(
 region text PRIMARY KEY CHECK(region IN ('CN','HK')),worker_id text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),heartbeat_at timestamptz NOT NULL DEFAULT now(),cycles bigint NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION nova_no_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='scales' THEN
  IF NEW.definition IS DISTINCT FROM OLD.definition OR NEW.version IS DISTINCT FROM OLD.version OR NEW.scale_id IS DISTINCT FROM OLD.scale_id THEN RAISE EXCEPTION 'Scale versions are immutable'; END IF;
 END IF;
 IF TG_TABLE_NAME='content_versions' THEN RAISE EXCEPTION 'Content versions are immutable'; END IF;
 IF TG_TABLE_NAME='reports' THEN RAISE EXCEPTION 'Reports are immutable'; END IF;
 IF TG_TABLE_NAME='assessments' THEN
  IF OLD.submitted_at IS NOT NULL AND (NEW.answers IS DISTINCT FROM OLD.answers OR NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.respondent_id IS DISTINCT FROM OLD.respondent_id OR NEW.respondent_role IS DISTINCT FROM OLD.respondent_role OR NEW.scale_version_id IS DISTINCT FROM OLD.scale_version_id OR NEW.family_id IS DISTINCT FROM OLD.family_id OR NEW.region IS DISTINCT FROM OLD.region OR NEW.locale IS DISTINCT FROM OLD.locale) THEN RAISE EXCEPTION 'Submitted assessments are immutable'; END IF;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS scales_immutable ON scales;
CREATE TRIGGER scales_immutable BEFORE UPDATE ON scales FOR EACH ROW EXECUTE FUNCTION nova_no_version_update();
DROP TRIGGER IF EXISTS content_immutable ON content_versions;
CREATE TRIGGER content_immutable BEFORE UPDATE ON content_versions FOR EACH ROW EXECUTE FUNCTION nova_no_version_update();
DROP TRIGGER IF EXISTS reports_immutable ON reports;
CREATE TRIGGER reports_immutable BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION nova_no_version_update();
DROP TRIGGER IF EXISTS assessments_immutable ON assessments;
CREATE TRIGGER assessments_immutable BEFORE UPDATE ON assessments FOR EACH ROW EXECUTE FUNCTION nova_no_version_update();
COMMIT;
