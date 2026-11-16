# AUTH-02 — Live operator activation

**Status: PARTIAL.** The local application is prepared for private, read-only M32 access, but the live operator prerequisites are not satisfied. The live-data flag remains off, and no OTP request or M32 read was made.

## Current audit

| Check | Result | Evidence |
| --- | --- | --- |
| Supabase Auth URL | Configured; valid URL shape in local runtime | Checked without printing the value |
| Supabase publishable key | Configured; accepted public-key shape in local runtime | Checked without printing the value |
| Private operator allowlist | **Not configured locally; 0 operators** | `EDITORIAL_OPERATOR_EMAILS` parses to an empty list |
| Email identity verification | Unknown for the hosted project | The app requires a verified `email_confirmed_at` and exact normalized allowlist match |
| Auth email provider | Unknown currently; AUTH-01 last observed it enabled | Hosted project settings were not re-read |
| Email confirmation | Unknown currently; AUTH-01 last observed auto-confirm off | Hosted project settings were not re-read |
| Public signup | **Unknown currently**; AUTH-01 last observed general signup enabled | No supported project-management connector is available |
| Local/QA Site URL | Not configured | `NEXT_PUBLIC_SITE_URL` and `EDITORIAL_AUTH_ORIGIN` do not provide an HTTPS QA origin |
| Hosted redirect allowlist | Unknown | Supabase dashboard settings were not queried |
| Production cookie policy | Pass by code inspection and AUTH-01 tests | HttpOnly, SameSite=Lax, host-only; Secure in production |
| `EDITORIAL_LIVE_DATA_ENABLED` | **Off** | Local runtime and tracked `.env.example` are not enabled |
| M32 live read | Not run | Activation prerequisites failed; hosted M32 state was not queried |

The app’s OTP request path normalizes the submitted email, only calls Supabase for an exact allowlisted identity, and sets `shouldCreateUser: false`. It returns a uniform response and does not log provider errors, email addresses, tokens, or cookies. The server authorization guard independently requires a verified user identity and exact allowlist match.

The code policy for production cookies is HttpOnly, SameSite=Lax, host-only, and Secure. Editorial pages are dynamic and M32 reads use private `no-store` fetches. AUTH-01’s isolated local integration previously verified anonymous and unauthorized denial, refresh, logout, and subsequent denial. AUTH-02 did not repeat those HTTP checks because no local Auth runtime was available and browser loopback access was blocked.

## OTP and live access

`OTP_REQUEST: NOT_RUN` and `OTP_HUMAN_COMPLETION: NOT_RUN`. No email was sent. The allowlist is empty in the local runtime, there is no configured HTTPS QA origin, and current hosted Auth settings and delivery are unknown. AUTH-01’s last report classified delivery as `AUTH_EMAIL_DELIVERY_NOT_CONFIGURED`; this run did not re-test it. Supabase’s built-in email service can be used for limited testing, but it only sends to pre-authorized organization members and has rate limits; delivery must be proven with the intended operator before relying on it ([Supabase email delivery](https://supabase.com/docs/guides/auth/auth-smtp)).

The hosted dashboard snapshot in AUTH-01 reported general signup enabled and email auto-confirm disabled. Those are historical observations, not a current read. Supabase documents the signup and email-confirmation controls under Authentication general/provider configuration ([Supabase Auth configuration](https://supabase.com/docs/guides/auth/general-configuration)). The Site URL and allowed redirect list are managed under URL Configuration ([Supabase redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls)).

## Verification

- AUTH-01 policy tests: **8 passed**.
- UI-06 regression tests: **11 passed**.
- UI-07 live-adapter tests: **10 passed**.
- `npm run lint`: **PASS**.
- `npx tsc --noEmit`: **PASS**.
- `npm run build`: **PASS** after clearing only the verified generated `.next` directory and allowing the build to fetch the existing Google font assets.
- Secret audit: **PASS**, 1,115 files scanned, zero finding files; `.env.local` remains ignored.
- `git diff --check`: **PASS**.
- Existing AUTH-01 isolated local Auth integration artifact: **PASS**, 15 recorded cases, synthetic local identities and Mailpit only. It was not rerun because `.auth-01-local/runtime.json` is absent and Docker Engine access is denied.
- UI-07 synthetic M32 service tests and bundle scan: **PASS**. No real DTO or live response was captured in AUTH-02.

## Manual actions required

1. In the intended Supabase project, open **Authentication → General Configuration** and disable **Allow new users to sign up**. Confirm the email provider remains enabled, email confirmation is required, and anonymous sign-ins are disabled. AUTH-01 last observed signup enabled; re-check the current project state before proceeding.
2. Add the approved operator’s exact, verified email to the private runtime variable `EDITORIAL_OPERATOR_EMAILS`. Do not put it in tracked files or send it in chat. The application trims and lowercases entries and rejects wildcards and malformed lists.
3. Configure the actual non-production HTTPS QA origin in the QA runtime as `EDITORIAL_AUTH_ORIGIN` and `NEXT_PUBLIC_SITE_URL`. In **Authentication → URL Configuration**, set the matching Site URL and add only the exact QA redirect origin/path required by the deployed auth flow. The app requires production auth origins to use HTTPS.
4. Verify that the project’s existing Auth email delivery can send to that authorized operator. The default Supabase mailer may be sufficient for a team member; custom SMTP is not assumed or requested.
5. Open `/editorial/login` on that HTTPS QA origin. The authorized operator should request one OTP and complete it directly in the browser from their inbox. Do not paste the OTP or session tokens into chat.
6. After the authenticated session and allowlist are confirmed, run the first live M32 read with `EDITORIAL_LIVE_DATA_ENABLED=true` in that QA runtime only. Keep the flag off in tracked config and production. If the real inbox is empty, `Todo al día` is a valid result; do not create a synthetic review in QA/production.

## Readiness

Live operator readiness is **NO** and AUTH-02 is **PARTIAL**. No real authorized session, HTTPS QA origin, current signup setting, real email delivery, or real M32 response was verified. UI-07 visual QA remains `INCOMPLETE_VISUAL_QA`; the local browser could not reach loopback and no authenticated session was available. The existing login screenshots under `artifacts/auth-01/evidence/` are prior AUTH-01 evidence, not AUTH-02 live-data evidence.

Editorial mutations, review decisions, push sends, pipeline runs, scheduler runs, migrations, production deployments, and real M32 reads during this phase: **0**. `READY FOR UI-08 REAL DECISIONS: NO`.
