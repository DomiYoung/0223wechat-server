# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
- Single-process Hono API service for a wedding mini-program frontend and an Admin CMS.
- Main runtime entry is `src/index.ts`, serving both public and admin routes on port 8199.

## Codebase Rules (CRITICAL)
1. **Port**: The application MUST run on port `8199`. Do not use `3000` or change it.
2. **Package Manager**: Always use `bun` for managing dependencies and running scripts (e.g., `bun install`, `bun run dev`, `bun run build`). Do NOT use `npm`.
3. **Framework**: The web framework is `Hono`. Do NOT use `Express`.

## Tech Stack & Runtime
- TypeScript (NodeNext) with `tsx` for development and `tsc` for build output.
- Node.js + Hono (`@hono/node-server`).
- MySQL (`mysql2/promise`) with startup initialization in `src/db.ts`.
- Aliyun OSS (`ali-oss`) for file upload and URL persistence.
- Package manager evidence: npm (`package-lock.json`, README command examples).

## Common Commands

### Available (repository-confirmed)
```bash
bun install
bun run dev
bun run build
bun run start
```

### Manual scripts (not registered in `package.json` scripts)
```bash
npx tsx scripts/migrate.ts
node update_db.js
```

### Not configured / cannot be assumed
- `npm run lint` (no lint script/config found)
- `npm test` / `npm run test` (no test script/framework found)
- `npm run typecheck` (no dedicated script; `npm run build` runs `tsc`)
- E2E command (no e2e script/framework found)
- Single-test command (no test runner configured)

## Repository Structure (Big Picture)
- `src/index.ts`: Hono app entry; defines public API (`/api/*`), admin API (`/api/admin/*`), upload API (`/api/upload`), and server startup.
- `src/db.ts`: MySQL infrastructure layer (`getPool`) and boot-time schema/seed initialization (`initDatabase`).
- `scripts/migrate.ts`: offline migration/ETL (external JSON/assets -> OSS -> MySQL), not part of regular service startup.
- `update_db.js`: one-off manual schema patch script (`ALTER TABLE ...`) for existing databases.
- `public/uploads` compatibility path: `/uploads/*` is served from `./public` in code; the directory may be absent until needed.

## API Boundaries & Data Flow
- Public mini-program reads home/case/venue data from MySQL via `/api/home`, `/api/cases/live`, `/api/cases/:id`, `/api/venues`.
- Public booking flow writes lead data into `reservation` via `POST /api/booking`.
- Admin CMS reads/updates cases, venues, and reservations under `/api/admin/*`.
- File upload uses `POST /api/upload`: parse multipart -> upload to OSS -> return HTTPS URL.
- Uploaded/migrated URLs are persisted in business tables (for example `wedding_case.cover_url`, `case_image.image_url`) and then returned by APIs.
- Route namespaces are path-isolated (`/api/*` vs `/api/admin/*`) but implementation is currently concentrated in `src/index.ts`.

## Database Initialization & Migration Notes
- `initDatabase()` in `src/db.ts` creates database/tables and seed records at startup.
- `src/index.ts` calls `initDatabase()` before `serve(...)`; if DB init fails, the server still starts and logs warnings.
- `scripts/migrate.ts` is a separate bulk import/migration flow and must be run manually.
- `update_db.js` is a manual schema patch helper for drifted environments, not recurring runtime logic.

## Known Gaps / Current Limitations
- No repository-level lint workflow is configured.
- No repository-level unit/integration/e2e test workflow is configured.
- No dedicated single-test command is available.
- Admin auth is currently thin: login returns a generated token string, and admin routes do not show centralized auth middleware in `src/index.ts`.
