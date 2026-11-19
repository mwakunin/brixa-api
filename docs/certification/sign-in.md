# Signing in

Status as of F3 (2026-11-18). Regulation 12 of the Digital Health (Health Information Management Procedures) Regulations 2025 (Legal Notice 76) says user accounts "shall adopt multi-factor authentication". It also asks for a limit on failed logins and a log of login attempts and password changes. DHA's certification framework asks for accounts to be locked after repeated wrong passwords. The exact wording to meet waits on DHA's certification guide (`SPEC.md` §4, question 11).

The decision behind these controls is in `SPEC.md` §2 ("Two-step sign-in for everyone").

## Two-step sign-in

| Control | Where | Proven by |
|---|---|---|
| Every sign-in asks for a code from an authenticator app after the password. There is no session until the code is right, except for someone who has not set an authenticator up yet: the password gives them a session good for setting one up and for nothing else (below) | `src/lib/auth.ts` (Better Auth's two-factor plugin) | `src/lib/two-factor.test.ts` ("asks for a code after the right password…") |
| Ten backup codes, given once at setup, each good once | The same | "takes a backup code instead…" |
| No computer is remembered, so the code is asked at every sign-in | `twoFactorRules` in `src/lib/auth.ts` | "refuses to remember a computer…" |
| Nobody works before setting an authenticator up: every API route refuses them with `two_factor_setup_required`, platform staff included | `withSession` and `notSignedIn` in `src/middlewares/auth.ts` | "gives a session from the password alone…", "refuses the platform's own staff…", `src/routes/onboarding.test.ts` |
| Setting one up asks for the password, and counts only once the first code from it is right. It then ends every other session the person had, each made by the password alone | The two-factor plugin, `twoFactorRules` in `src/lib/auth.ts` | "sets one up with the password…", "ends the person's other sessions…" |
| Turning it off asks for the password, tells the person by email, and sends them back to setting it up | The plugin, and `databaseHooks.user` in `src/lib/auth.ts` | "is where turning it off sends the person back to…" |
| Authenticator secrets and backup codes are stored only encrypted, in a table the app role cannot read | `src/db/auth-schema.ts`, `src/db/migrations/0109_two_factor_grants.sql`, `encryption.md` | `src/db/rls.test.ts` ("refuses the app role: SELECT secret FROM two_factor") |

## Limits on failed attempts

| Control | Where | Proven by |
|---|---|---|
| Five wrong codes in a row lock the account for 15 minutes, from wherever they come | `accountLockout` in `src/lib/auth.ts` | "locks the account for fifteen minutes…" |
| Each challenge for a code takes at most five tries | The two-factor plugin | Better Auth's own tests |
| Password guesses are limited per account from one address (10 in 15 minutes), per account from anywhere (100 in 15 minutes) and per address (10 a minute) | `src/lib/create-app.ts`, `src/middlewares/rate-limit.ts` | `src/middlewares/rate-limit.test.ts` |
| Code checks are limited per address (30 a minute), apart from the sign-in budget | The same | "checks codes under their own address limit…" |

## Sessions

| Control | Where | Proven by |
|---|---|---|
| A password reset ends every session, and every sign-in still waiting for its code. A code whose password changed after its challenge was made gets no session, even if the reset commits after the challenge is spent | `onPasswordReset` and the session hook in `src/lib/auth.ts` | `src/lib/auth.test.ts` ("sets the new password, ends every session…"), "ends a sign-in still waiting for its code…", "refuses a session to a code whose password changed…" |
| Every change to how someone signs in is emailed to them: a password reset, an authenticator set up, two-step sign-in turned off | `src/lib/auth.ts` | The same tests |

## Not yet done

- **A log of sign-ins**, failed attempts, lockouts and password changes, append-only and kept 20 years, with an export for the quarterly review. Next, in brixa-api. An auditor's screen comes with the administration screens.
- **An explicit lock after repeated wrong passwords**, logged. The limits above already stop guessing; the lock makes it the control the certification framework names. Next, with the log.
- **Help for someone who has lost both their phone and their backup codes**: Brixa support resets their two-step sign-in after checking who they are. Next, with the log.
- **A code can be used again within its window.** NIST SP 800-63B asks that each time-based code be accepted once. Better Auth accepts a code for about 90 seconds and does not record the last one used. Someone who saw a code would still need the password.
- **Staff without a smartphone.** Text-message codes, if the staff walkthrough shows the need.
