-- Two-step sign-in (decided 2026-11-18, SPEC.md §2): the two-factor plugin's
-- table belongs to Better Auth's role alone, as the other identity tables do
-- (0001). It holds each person's authenticator secret and backup codes,
-- encrypted, and the count of wrong codes that locks an account. The app
-- role gets nothing: no handler needs any of it, and `user.two_factor_enabled`
-- stays outside the columns the app may read of "user".
GRANT SELECT, INSERT, UPDATE, DELETE ON "two_factor" TO hospital_auth;
