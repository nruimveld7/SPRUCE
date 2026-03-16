# Shift Schedule - Agent Onboarding

## Purpose
This application is the future replacement for a spreadsheet-driven shift scheduling workflow.

Core goals:
- Model schedule access and management in a database-first way.
- Support schedule-specific customization (patterns, coverage codes, events).
- Render schedules from effective-dated data (not static spreadsheet cells).

## Stack and Runtime
- Framework: `SvelteKit` + TypeScript.
- Backend DB: Microsoft SQL Server (Docker container).
- Auth: Microsoft Entra ID (OIDC + PKCE + certificate-based client assertion).
- Session storage: SQL table `dbo.UserSessions`.
- Reverse proxy: `nginx` in Docker compose.

## Access Model
Fixed role catalog (`dbo.Roles`):
- `Member`: read-only access to assigned schedules.
- `Maintainer`: member capabilities + operational schedule changes.
- `Manager`: maintainer capabilities + high-level schedule administration.

Bootstrap model for first-time initialization:
- Env var `BOOTSTRAP_MANAGER_OIDS` contains allowed OIDs.
- Matching users are tracked in `dbo.BootstrapManagers`.
- Bootstrap managers can access first-time setup when no schedule users exist yet.

## Current Route-Level Behavior
Auth/guard logic is in `src/hooks.server.ts`.

Public paths:
- `/auth/login`
- `/auth/callback`
- `/favicon.ico`

Protected flow:
- No valid session: redirect to `/auth/login`.
- Bootstrap manager and no `ScheduleUsers` rows yet: redirect to `/setup`.
- User with no access: redirect to `/unauthorized`.
- Authorized users avoid `/unauthorized` and go to `/`.

Primary routes:
- `/`: main app shell (currently scaffolded for schedule-backed rendering).
- `/setup`: first-time schedule creation for bootstrap manager.
- `/unauthorized`: gated messaging page.
- `/sample`: frozen snapshot/demo view.
- `/test`: dev/test utilities page.

## Session and Identity
Auth/session implementation: `src/lib/server/auth.ts`.

Important details:
- Session cookie key: `app_session`.
- Session records are stored in `dbo.UserSessions`.
- `UserSessions` includes `ActiveScheduleId` (current schedule context per session).
- On login/session read, user profile is upserted into `dbo.Users`.

Per-session active schedule:
- Read via `getActiveScheduleId(...)`.
- Updated via `setActiveScheduleForSession(...)`.

## Database Structure (Current)
Schema source of truth: `db/schema.sql`.

Primary tables:
- `dbo.Users`: Entra-backed user identity/profile cache.
- `dbo.BootstrapManagers`: first-time setup gate.
- `dbo.Schedules`: schedule records.
- `dbo.Roles`: fixed role catalog.
- `dbo.ScheduleUsers`: user-to-schedule role assignments.
- `dbo.Patterns`: schedule-scoped pattern definitions (`PatternJson`).
- `dbo.EmployeeTypes`: schedule-scoped employee types mapped to patterns.
- `dbo.CoverageCodes`: schedule-scoped display/coverage code metadata.
- `dbo.ScheduleUserTypes`: effective-dated employee type mapping per user.
- `dbo.ScheduleEvents`: effective-dated schedule/user events and overrides.

Constraints/indexing highlights:
- Role uniqueness on `dbo.Roles(RoleName)`.
- Date range check constraints on effective-dated tables.
- Overlap prevention trigger: `dbo.TR_ScheduleUserTypes_NoOverlap`.
- Indexes for month/window queries on `ScheduleUserTypes` and `ScheduleEvents`.

Soft-delete strategy:
- Most business tables include `IsActive`, `DeletedAt`, `DeletedBy`.

## Scheduling Model (Design Intent)
This project uses an event-driven/effective-dated model:
- Store patterns, coverage codes, type mappings, and events.
- Query only rows intersecting target time windows (typically month view).
- Compute final visual schedule at runtime.

No global templates:
- Patterns, employee types, and coverage codes are schedule-scoped.

## First-Time Setup Behavior
First-time setup implementation: `src/routes/setup/+page.server.ts`.

Current behavior:
- Bootstrap manager creates first schedule by name.
- Creator is auto-assigned `Manager` role on that schedule.
- Bootstrap row for that user is deactivated.
- Session `ActiveScheduleId` is set to the newly created schedule.

## Local Development Runbook
Project layout assumptions:
- Compose root is parent directory (`../` from this workspace).
- App source root is this directory (`shiftschedule`).

Key scripts (from `../scripts`):
- `StartDev.sh`: build and start dev stack.
- `StopDev.sh`: stop dev stack.
- `SqlRun.sh`: run ad-hoc SQL against dev/prod compose SQL Server.

Typical commands:
```bash
../scripts/StartDev.sh
../scripts/StopDev.sh
```

Apply schema:
```bash
/bin/bash -lc "set -a; source ../.env.dev; set +a; ../scripts/SqlRun.sh dev shiftschedule < db/schema.sql"
```

Seed data:
```bash
/bin/bash -lc "set -a; source ../.env.dev; set +a; ../scripts/SqlRun.sh dev shiftschedule < db/seed.sql"
```

## Environment Variables (Operationally Important)
Defined in compose/env files outside this directory:
- `SA_PASSWORD`
- `MSSQL_HOST`
- `MSSQL_PORT`
- `MSSQL_USER`
- `MSSQL_PASSWORD`
- `MSSQL_DATABASE`
- `MSSQL_ENCRYPT`
- `MSSQL_TRUST_SERVER_CERT`
- `ENTRA_TENANT_ID`
- `ENTRA_CLIENT_ID`
- `ENTRA_REDIRECT_URI`
- `ENTRA_CLIENT_CERT_PRIVATE_KEY_PATH` (optional override; default: `/app/certs/entra-client.key`)
- `ENTRA_CLIENT_CERT_PUBLIC_CERT_PATH` (optional override; default: `/app/certs/entra-client.crt`)
- `BOOTSTRAP_MANAGER_OIDS`
- `DEV_CONSOLE_ALLOWED_OIDS` (optional, dev-only console command allowlist)

`BOOTSTRAP_MANAGER_OIDS` delimiter support:
- comma, semicolon, or whitespace.

## Agent Notes / Guardrails
- Treat `db/schema.sql` as authoritative for data model changes.
- Preserve soft-delete behavior unless explicitly told to hard-delete.
- Access checks are backend-driven; do not trust frontend-only gating.
- Keep schedule-scoped customization local to `ScheduleId` (no global templates).
- Use Entra OID (`UserOid`) as stable user key; avoid email as identity key.

## Package Manager
- In this environment, npm is not accessible.
- Prefer yarn for any package operations.
