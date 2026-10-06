# Supabase and GitHub Connection

The **PerpParrot** Supabase project is connected to this GitHub repository. The integration was enabled and verified again after reloading the settings page on **6 October 2026**.

## Connected resources

| Setting | Saved value |
| --- | --- |
| Supabase project | PerpParrot |
| Project reference | `clheeepphmomkymawsfq` |
| GitHub repository | `JamesBurnsBacon/PerpParrot-Onchain-Trading-Agent-by-QuantFun` |
| Working directory | `.` |
| Stored production branch | `main` |
| Deploy to production | Off |
| Automatic branching | Off |

[Open the Supabase integration](https://supabase.com/dashboard/project/clheeepphmomkymawsfq/settings/integrations) · [Open the project](https://supabase.com/dashboard/project/clheeepphmomkymawsfq) · [Read the verification report](VERIFICATION.md)

## What is ready

The project-to-repository connection is saved. An authorized team member can open **Project Settings → Integrations → GitHub** and inspect the connected repository and options.

Automatic production deployment and preview branching are disabled. This connection does not yet provide a tested database deployment pipeline or an application-to-database connection. The stored branch is `main`; its field is inactive while production deployment is off.

The working directory `.` refers to the repository root, where a future `supabase/` configuration directory would live. `docs/supabase/` contains documentation only. At verification, the repository had no root-level `supabase/` directory. Configuration, migrations, and deployment testing are separate future work.

## Evidence

- [Verification report](VERIFICATION.md): procedure, results, and acceptance criteria.
- [Connection screenshot](evidence/supabase-github-connected.jpg): saved settings after reload.
- [Configuration record](evidence/connection-verification.json): exact repository, settings, timestamp, and screenshot checksum.

The evidence contains no passwords, API keys, tokens, or team email addresses. Supabase dashboard links still require an authorized account.

Reference: [Supabase GitHub integration guide](https://supabase.com/docs/guides/deployment/branching/github-integration).
