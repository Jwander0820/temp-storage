# Contributing

Thanks for helping improve Jwander Temp Storage. Keep changes small, reviewable, and covered by the
relevant tests.

## Local setup

- Use Node.js 22 and the repository-declared `pnpm@11.9.0`.
- Copy `.dev.vars.example` to `.dev.vars` and use local-only test values. Never commit that file.
- Apply local migrations with `pnpm run db:migrate:local`.
- Run the service with `pnpm dev`.
- Before opening a pull request, run `pnpm check`.

See [`docs/development/local-testing.md`](./docs/development/local-testing.md) for the complete local
workflow. Use Conventional Commits as described in
[`docs/development/commit-conventions.md`](./docs/development/commit-conventions.md).

## Safety boundaries

- Never commit tokens, secrets, `.dev.vars`, `.env`, invitation links, delete URLs, object keys, or user
  data.
- Do not run remote migrations, deploy a Worker, or modify the maintainer's Cloudflare account, D1,
  R2, DNS, Access, WAF, or billing configuration as part of a pull request.
- Keep all project R2 operations inside `temp-storage/objects/`.
- Add a new migration for schema changes; do not rewrite migrations that may already be deployed.
- Preserve the invitation capability, HttpOnly session, quota ledger, and distinct admin/delete-token
  privilege boundaries unless an approved design explicitly changes them.

## Pull requests

Explain the behavior and reason for the change, identify migrations or security implications, and list
the checks you ran. Do not include production screenshots or logs that reveal account identifiers,
rules, traffic, billing thresholds, or capability URLs.
