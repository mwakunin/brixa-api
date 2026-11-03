-- The two unprivileged roles the application connects as (CLAUDE.md §4,
-- layer 1).
--
--   hospital_app   serves every tenant request. Subject to row-level security.
--   hospital_auth  Better Auth's alone: the only role that can read sessions,
--                  password hashes and verification tokens. It holds nothing
--                  on the tenant tables.
--
-- Why separate roles at all: Postgres row-level security does not apply to a
-- table's OWNER, and is bypassed outright by a SUPERUSER. The local Docker
-- role `hospital` is both: it owns the tables because it runs the migrations,
-- and POSTGRES_USER is a superuser. If the app connected as `hospital`, every
-- RLS policy would be silently inert. `FORCE ROW LEVEL SECURITY` (see the RLS
-- migration) closes the owner half; only an unprivileged role closes the
-- superuser half.
--
-- Why the auth role is split from the app role: the auth tables cannot carry
-- tenant policies (identity is global), so whatever role can read them can
-- read every facility's staff sessions. Keeping that out of the role tenant
-- handlers run as means a bug in one handler cannot reach a session token.
--
-- NOBYPASSRLS and NOSUPERUSER are already the defaults. They are stated so a
-- future edit has to actively remove them.
--
-- Run this once per database, as a superuser:
--
--   local dev   mounted into /docker-entrypoint-initdb.d (docker-compose.yml)
--   CI          an explicit psql step (.github/workflows/ci.yml)
--   managed     psql "$ADMIN_URL" --single-transaction -v ON_ERROR_STOP=1 -f db/roles.sql \
--                 -c "ALTER ROLE hospital_app PASSWORD '<from the secret manager>'" \
--                 -c "ALTER ROLE hospital_auth PASSWORD '<from the secret manager>'"
--
-- The passwords below are local-development defaults that anyone can read
-- here, so a managed database must never be left with them. The recipe
-- replaces them in the same psql run, and `--single-transaction` makes the
-- whole run one transaction: if it stops before the passwords are replaced,
-- the roles are not created at all, rather than created with these.
--
-- IF NOT EXISTS skips a role that already exists without re-checking its
-- attributes. The API checks both roles itself at boot
-- (`assertConnectionsAreRestricted` in src/db/index.ts) and refuses to serve
-- as a superuser or BYPASSRLS role.
--
-- ---------------------------------------------------------------------------
-- DEPLOYMENT REQUIREMENT for the OWNER connection (DATABASE_URL)
--
-- FORCE ROW LEVEL SECURITY subjects even the table owner to the policies, so
-- the owner connection keeps its cross-tenant reach only if its role is a
-- SUPERUSER or holds BYPASSRLS. Locally and in CI it is a superuser. On a
-- managed host (Cloud SQL, or a Kenyan provider) it usually is not, so the
-- superadmin plane would list zero facilities and the test harness would
-- truncate nothing. Provision DATABASE_URL from a role that can bypass:
--
--   ALTER ROLE <owner> BYPASSRLS;
--
-- Cloud SQL restricts this differently from plain Postgres; check before go
-- live. `rls.test.ts` asserts it, so a wrong deployment fails a test.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hospital_app') THEN
    CREATE ROLE hospital_app
      LOGIN PASSWORD 'hospital_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hospital_auth') THEN
    CREATE ROLE hospital_auth
      LOGIN PASSWORD 'hospital_auth'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- Lets the roles reach the schema at all. Table privileges are granted by the
-- migration that creates the tables, alongside the policies that constrain
-- them, so the grants cannot drift out of step with the schema.
GRANT USAGE ON SCHEMA public TO hospital_app, hospital_auth;
