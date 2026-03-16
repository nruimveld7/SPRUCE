# SPRUCE 

Shift Planning, Rostering, and User Coverage Engine

Database-first shift scheduling application built with SvelteKit + TypeScript, backed by Microsoft SQL Server, with Microsoft Entra ID authentication.

## Purpose

This project replaces a spreadsheet-driven schedule workflow with an effective-dated/event-driven model.

Core goals:
- Manage schedules and access in a database-first way.
- Support schedule-specific customization (patterns, employee types, coverage codes).
- Render schedules from effective-dated data, not static spreadsheet cells.

## Tech Stack

- Frontend/app: SvelteKit + TypeScript
- Database: Microsoft SQL Server
- Auth: Microsoft Entra ID (OIDC + PKCE + certificate-based client assertion)
- Session store: SQL table `dbo.UserSessions`
- Runtime/deployment: Node.js (with optional container images via `Dockerfile`/`Dockerfile.dev`)

## Project Layout

- `src/hooks.server.ts`: global auth/access guard
- `src/lib/server/auth.ts`: OIDC login/callback/session logic
- `src/lib/server/access.ts`: access-state resolution
- `src/routes/setup/+page.server.ts`: first-time setup action
- `db/schema.sql`: authoritative database schema
- `db/seed.sql`: optional seed data

## Access Model

Roles are fixed in `dbo.Roles`:
- `Member`
- `Maintainer`
- `Manager`

Bootstrap model:
- `BOOTSTRAP_MANAGER_OIDS` contains Entra OIDs allowed to perform first-time setup.
- Bootstrap users are mirrored in `dbo.BootstrapManagers`.

Current guard behavior (`src/hooks.server.ts`):
- Public routes: `/auth/login`, `/auth/callback`, `/favicon.ico`
- No valid session: redirect to `/auth/login`
- Bootstrap user with no schedule access: redirect to `/setup`
- User without access: redirect to `/unauthorized`
- Authorized users are redirected away from `/unauthorized` to `/`

## Current Routes

- `/`: main app shell (loads active schedule + current user role)
- `/setup`: first-time schedule creation (bootstrap-only)
- `/unauthorized`: access-pending page
- `/test`: dev/test utility page and API helpers

## Database Model (Current)

See `db/schema.sql` for exact definitions.

Primary tables:
- `dbo.Users`
- `dbo.BootstrapManagers`
- `dbo.Schedules`
- `dbo.Roles`
- `dbo.ScheduleUsers`
- `dbo.Patterns`
- `dbo.EmployeeTypes`
- `dbo.CoverageCodes`
- `dbo.ScheduleUserTypes`
- `dbo.ScheduleEvents`
- `dbo.UserSessions` (created/maintained by auth layer)

Schema notes:
- Soft-delete fields (`IsActive`, `DeletedAt`, `DeletedBy`) are used across business tables.
- Date-range constraints and overlap protections are enforced in SQL.
- Indexes are included for schedule/month window queries.

## Prerequisites

- Node.js 20+
- Yarn (project uses Yarn 4; see `packageManager` in `package.json`)
- Microsoft SQL Server instance accessible from this app
- Microsoft Entra app registration and certificates for OIDC login

## Environment Variables

Used by app and DB connection logic:

- SQL: `MSSQL_HOST`, `MSSQL_PORT`, `MSSQL_USER`, `MSSQL_PASSWORD`, `MSSQL_DATABASE`, `MSSQL_ENCRYPT`, `MSSQL_TRUST_SERVER_CERT`
- Entra/Auth: `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_REDIRECT_URI`, `ENTRA_REDIRECT_URI_FORCE` (optional)
- Entra cert path overrides (optional): `ENTRA_CLIENT_CERT_PRIVATE_KEY_PATH`, `ENTRA_CLIENT_CERT_PUBLIC_CERT_PATH` (defaults: `/app/certs/entra-client.key`, `/app/certs/entra-client.crt`)
- App: `BOOTSTRAP_MANAGER_OIDS`
- Optional (dev API guard): `DEV_CONSOLE_ALLOWED_OIDS`

`BOOTSTRAP_MANAGER_OIDS` accepts comma, semicolon, or whitespace delimiters.

## Local Development

Install dependencies:
```bash
yarn install
```

Run the app in dev mode:
```bash
yarn dev
```

Apply schema (example using `sqlcmd`):
```bash
sqlcmd -S "$MSSQL_HOST,$MSSQL_PORT" -U "$MSSQL_USER" -P "$MSSQL_PASSWORD" -d "$MSSQL_DATABASE" -i db/schema.sql -C
```

Optional seed data:
```bash
sqlcmd -S "$MSSQL_HOST,$MSSQL_PORT" -U "$MSSQL_USER" -P "$MSSQL_PASSWORD" -d "$MSSQL_DATABASE" -i db/seed.sql -C
```

Run app checks from this directory:
```bash
yarn check
yarn lint
yarn test:unit
```

Build for production:
```bash
yarn build
```

## First-Time Setup Flow

1. User logs in via Entra (`/auth/login` -> `/auth/callback`).
2. Session is created in `dbo.UserSessions` (cookie: `app_session`).
3. If user is bootstrap and there are no schedule assignments yet, user is redirected to `/setup`.
4. Setup creates the first schedule and assigns the creator as `Manager` on that schedule.
5. Session `ActiveScheduleId` is set to the newly created schedule.

## Notes

- `db/schema.sql` is the source of truth for data model changes.
- Access control is enforced on the backend; frontend state is not trusted for authorization.
- Use Entra OID (`UserOid`) as the stable user identity key.
