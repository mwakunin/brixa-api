# Signing in

Status as of F3 (2026-11-19). Regulation 12 of the Digital Health (Health Information Management Procedures) Regulations 2025 (Legal Notice 76) says user accounts "shall adopt multi-factor authentication". It also asks for a limit on failed logins and a log of login attempts and password changes. DHA's certification framework asks for accounts to be locked after repeated wrong passwords. The exact wording to meet waits on DHA's certification guide (`SPEC.md` §4, question 11).

The decisions behind these controls are in `SPEC.md` §2 ("Two-step sign-in for everyone"; "The sign-in log, the password lock and support resets").

## Two-step sign-in

| Control | Where | Proven by |
|---|---|---|
| Every sign-in asks for a code from an authenticator app after the password. There is no session until the code is right, except for someone who has not set an authenticator up yet: the password gives them a session good for setting one up and for nothing else (below) | `src/lib/auth.ts` (Better Auth's two-factor plugin) | `src/lib/two-factor.test.ts` ("asks for a code after the right password…") |
| Ten backup codes, given once at setup, each good once | The same | "takes a backup code instead…" |
| No computer is remembered, so the code is asked at every sign-in | `twoFactorRules` in `src/lib/auth.ts` | "refuses to remember a computer…" |
| Nobody works before setting an authenticator up: every API route refuses them with `two_factor_setup_required`, platform staff included | `withSession` and `notSignedIn` in `src/middlewares/auth.ts` | "gives a session from the password alone…", "refuses the platform's own staff…", `src/routes/onboarding.test.ts` |
| Setting one up asks for the password, and counts only once the first code from it is right | The two-factor plugin | "sets one up with the password…" |
| Once a person has an authenticator, only a session a code was given for counts. A session made by the password alone, before setup or by a sign-in still running as setup finished, gets nothing, Better Auth's own routes included (it cannot read the authenticator's secret back, renew the backup codes or turn two-step sign-in off), and is ended when next used | `databaseHooks.session` in `src/lib/auth.ts` (`twoFactorVerified` on each session), `endPasswordOnlySessions` and `withSession` in `src/middlewares/auth.ts` | "does not let the person's other sessions…", "refuses Better Auth's two-factor routes to a session made by the password alone…", "does not let a password sign-in that finished as setup completed work" |
| Turning it off asks for the password, tells the person by email, and sends them back to setting it up | The plugin, and `databaseHooks.user` in `src/lib/auth.ts` | "is where turning it off sends the person back to…" |
| Reading the authenticator's secret back, renewing the backup codes, turning two-step sign-in off and changing the password need a session a code was given for, whether or not the person has an authenticator yet. A session's flag never changes, so a setup finishing elsewhere while such a request runs cannot open these to it | `NEEDS_A_CODE` and `twoFactorRules` in `src/lib/auth.ts` | "refuses those routes to a session without a code even when setup finishes after it passed the guard", "keeps those routes for a session given a code" |
| Changes to one person's two-step sign-in run one at a time, so a confirmation activates only the authenticator whose code it checked, never one a second setup put in its place meanwhile. A second change while one runs is refused, to be tried again, not queued, and the lock's connections are apart from Better Auth's, so no burst of requests can hold up anyone's sign-in | `oneTwoFactorChangeAtATime` in `src/lib/auth.ts`, `withAdvisoryLock` in `src/db/index.ts` | "confirms only the authenticator whose code was checked…", "refuses a burst of changes for one person…", `src/db/advisory-lock.test.ts` |
| Authenticator secrets and backup codes are stored only encrypted, in a table the app role cannot read | `src/db/auth-schema.ts`, `src/db/migrations/0109_two_factor_grants.sql`, `encryption.md` | `src/db/rls.test.ts` ("refuses the app role: SELECT secret FROM two_factor") |

## Limits on failed attempts

| Control | Where | Proven by |
|---|---|---|
| Five wrong codes in a row at sign-in lock the account for 15 minutes, from wherever they come. Wrong codes while setting an authenticator up are not counted: setup already needs a session and the password, and its code checks fall under the address limit below | `accountLockout` in `src/lib/auth.ts` | "locks the account for fifteen minutes…" |
| Five wrong passwords with no right one between, all within 15 minutes of the first (the count starts with it and does not stretch), lock the account from that address for 15 minutes from the fifth, refusing even the right password; the lock is logged, and once it ends the count starts again. While Redis is down, each instance counts in its own memory, and a lock set there holds until it ends, even once Redis is back. Counted per account and address, so a stranger who knows an email cannot lock its owner out at their desk. A sign-in whose body is not JSON is refused before anything is counted, since only JSON names the account | `src/middlewares/sign-in-lock.ts` | `src/lib/sign-in-log.test.ts` ("the lock on wrong passwords"), `src/middlewares/sign-in-lock.test.ts` (while Redis is down) |
| Each challenge for a code takes at most five tries | The two-factor plugin | Better Auth's own tests |
| Password guesses are limited per account from one address (10 in 15 minutes), per account from anywhere (100 in 15 minutes) and per address (10 a minute) | `src/lib/create-app.ts`, `src/middlewares/rate-limit.ts` | `src/middlewares/rate-limit.test.ts` |
| Code checks are limited per address (30 a minute), apart from the sign-in budget | The same | "checks codes under their own address limit…" |

## Sessions

| Control | Where | Proven by |
|---|---|---|
| A password reset ends every session, and every sign-in still waiting for its code. A code whose password changed after its sign-in began gets no session: the challenge carries when the sign-in began, and the password is checked again before the challenge is spent and before the session is made. **One window is open:** a reset that commits after that last check and before Better Auth inserts the session still leaves one old-password session. Closing it needs a change inside Better Auth (`SPEC.md` §2) | `onPasswordReset`, `twoFactorRules` and the session and challenge hooks in `src/lib/auth.ts` | `src/lib/auth.test.ts` ("sets the new password, ends every session…"), "ends a sign-in still waiting for its code…", "refuses a code whose password changed after its challenge was made…", "…while its challenge was being made", "makes no session for a code whose password changed as its challenge was spent" |
| These changes to how someone signs in are emailed to them: a password reset or changed, an authenticator set up, two-step sign-in turned off, a reset by Brixa support. Sending is best effort, straight after the change (CLAUDE.md §7 lists the exception to the outbox): a notice that fails is logged, and one lost if the API stops at that moment is not sent again. The change still stands, and each shows itself at the person's next sign-in | `notify` in `src/lib/auth.ts`, `src/lib/sign-in-support.ts` | The same tests, "removes their authenticator, ends every session…", and `src/lib/auth.test.ts` ("changing a password") |

## The sign-in log

| Control | Where | Proven by |
|---|---|---|
| Every sign-in is logged, by the factor that finished it, with each wrong password and wrong code, each lock and each try while locked, and each sign-out | `src/lib/sign-in-log.ts`, `src/middlewares/sign-in-lock.ts` | `src/lib/sign-in-log.test.ts` ("the sign-in log") |
| Every change to how someone signs in is logged: a password reset or change, an authenticator set up or turned off, backup codes renewed, a reset by support | The same, and `src/lib/auth.ts` | The same |
| Each event records the address (as the trusted proxies report it) and the browser it came from. A password tried on an address with no account is recorded under no one, without what was typed | The same | "records a wrong password under its account…" |
| The log is append-only for every role, the owner included: neither an update, a delete nor a TRUNCATE gets through, and nothing deletes from it: kept at least 20 years | `src/db/migrations/0112_sign_in_events_append_only.sql` | "is append-only for every role…" |
| Of the roles the API runs as, only Better Auth's writes it, and it cannot read it back; the app role cannot touch it. An event of a sign-in, or of a change someone makes to their own sign-in, that cannot be written is logged as an error and never blocks or undoes what it describes, which has already happened. Brixa support's events are written on the owner connection, and the act waits for its event: a reset writes it in the reset's own transaction, so one that cannot be written undoes the reset, and an export records itself before anything is read, so one that cannot be recorded is refused | The same migration, `src/lib/sign-in-log.ts`, `src/lib/sign-in-support.ts` | The same test, "sets an authenticator up even when its event cannot be written…", "refuses a reset or an export whose event cannot be written…" |
| Brixa support exports it between two dates as CSV for the quarterly review, at most a year at a time and ten exports an hour each. Each export is logged before any of it is read, so none goes out unrecorded. It is read and sent a page at a time, so the API holds one page of it however long the range. Each page shows the log as it stands when that page is read: in a range that includes today, an event still being written as a page ends can be left out, so the quarterly review exports a quarter that has ended. Cells a spreadsheet would read as a formula are neutralised | `GET /superadmin/sign-in-events`, `src/lib/sign-in-support.ts` | "the export of the log, for Brixa support" |

## Lost phones

| Control | Where | Proven by |
|---|---|---|
| Someone who has lost both their phone and their backup codes is reset by Brixa support, after checking who they are, never by a facility admin. The reason is required and logged; nobody resets their own | `POST /superadmin/two-factor-resets`, `src/lib/sign-in-support.ts` | "resetting someone's two-step sign-in, by Brixa support" |
| A reset removes the authenticator and backup codes, ends every session and every sign-in waiting for a code, and emails the person. Their next sign-in sets up a new authenticator. It writes the time a password change would, so a code check already under way is refused its session. It runs under the lock the person's own changes take, so it is refused, to be tried again, while they are setting an authenticator up | The same | The same, "refuses a session to a code check under way when support resets…" and "refuses a reset while a change… is under way" |

## Not yet done

- **A database fault in the middle of setting an authenticator up.** Better Auth's setup is neither one transaction nor conditional on the secret whose code it checked, and two cases follow, each needing a database fault mid-request:
  - if the lock's connection drops while a confirmation runs, and the same person starts a second setup in that instant, the second authenticator could be confirmed without its code being checked;
  - if Better Auth fails after turning two-step sign-in on but before finishing, the person cannot finish setting it up.

  The person is emailed about any setup, and Brixa support's reset (`POST /superadmin/two-factor-resets`, above) clears either. Closing them needs Better Auth's setup to commit in one step, to be raised with Better Auth with the sign-in race.
- **Counts across a Redis outage.** While Redis is down, each instance counts wrong passwords in its own memory, and a count short of a lock does not move between the two stores when Redis goes or comes back. A lock is kept in both and holds until it ends, and a right password clears the count in memory (above). Two cases remain:
  - wrong passwords counted in one store do not add to those in the other, so each time Redis goes or comes back, up to four more can be tried before the lock;
  - a right password during an outage cannot clear a count Redis already held, so after Redis is back one more wrong password can lock that account from that address for 15 minutes.

  Closing them needs the count in one store. Postgres would do, since a sign-in needs it anyway.
- **An auditor's screen** for the quarterly review, with the administration screens. Until then, Brixa support exports the log.
- **A copy of the log that the database's owner cannot alter.** The trigger stops every role, but the owner could drop it. A write-once copy, such as a locked storage bucket, depends on where the system is hosted.
- **A code can be used again within its window.** NIST SP 800-63B asks that each time-based code be accepted once. Better Auth accepts a code for about 90 seconds and does not record the last one used. Someone who saw a code would still need the password.
- **Staff without a smartphone.** Text-message codes, if the staff walkthrough shows the need.
- **Before someone has set an authenticator up, their password alone stands for them**, as it did before two-step sign-in: whoever knows it could set one up first. The emailed notice of a setup is the safeguard. Tying the first setup to the invitation's emailed link would close it.
