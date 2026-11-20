# BOP Integration Guide (RoadsideRadioGateway)

This document describes how the future Broadcast Operations Platform (BOP) integrates with **RoadsideRadioGateway**. BOP does **not** exist yet and is **not** required by the gateway.

## Principles

- Gateway is the source of truth for presenter accounts, credentials validity, queue, and live connection state.
- BOP is the source of truth for user access decisions and (if needed) user-visible credential storage.
- The gateway **generates** presenter passwords; BOP must never supply plaintext passwords on account creation.
- The gateway **never** stores recoverable plaintext passwords and **never** returns an existing password after creation/regeneration responses.
- All BOP ↔ gateway calls are authenticated server-to-server requests over HTTPS.

## API authentication

- Configure a strong random API key in the gateway: `BOP_API_KEY`
- Send on every request: `Authorization: Bearer <BOP_API_KEY>` (or `X-API-Key`)
- Store the key in BOP's secret manager/config, not in source control
- Rotate by updating gateway config and BOP secret in a coordinated change
- Keep gateway management API (port 3000) on a private network; expose publicly only via trusted TLS termination and network controls if absolutely necessary

## Account model

- Statuses: `active`, `suspended`
- Revoked accounts are **deleted** (not retained as a status)
- Each account has a unique presenter ID and unique username; gateway stores Argon2id password hash only
- `externalUserRef` can store BOP's user identifier for correlation

## Grant broadcast access

1. BOP administrator enables broadcast access for a user and clicks Save.
2. BOP calls `POST /api/v1/presenters` with `Idempotency-Key`, `username`, `displayName`, and `externalUserRef`.
3. Gateway validates request, checks username uniqueness, generates a secure random password, hashes it with Argon2id, stores account as `active`, commits to DB.
4. Gateway returns `201` with `presenterId`, account fields, and `password` (once).
5. BOP encrypts and stores the password against the user's account (recommended: AES-256-GCM or equivalent authenticated encryption, with encryption keys held outside BOP's database, e.g. KMS/HSM/secret manager).
6. BOP stores `presenterId`, `username`, status, and linkage to the BOP user.
7. BOP refreshes the user management page.
8. User can view and copy broadcast credentials from BOP when required.

## Idempotency and retries

- Presenter creation supports idempotency via `Idempotency-Key` header (or body field where supported). Use a unique key per intended create operation.
- A retry with the same key must not create a second account.
- On replay of a completed create (same key + same payload), gateway returns presenter info with `idempotentReplay: true` and `password: null` because plaintext passwords are never stored/replayed.
- If BOP did not receive/store the original password response, BOP must call `POST /api/v1/presenters/:id/regenerate-password` to obtain a new password, then replace its stored encrypted password.
- Same key with different payload returns `409 conflict`.
- BOP should implement retry with exponential backoff for network errors/timeouts and treat `409/400/401/404` as non-retryable unless corrected.

## Suspend presenter

1. BOP calls `PATCH /api/v1/presenters/:id/status` with `{ "status": "suspended" }`.
2. Gateway prevents future connections, immediately disconnects any existing presenter connection, preserves account and password hash.
3. Gateway returns updated account status.
4. BOP updates stored status; credentials remain stored but inactive in gateway.

## Reactivate presenter

1. BOP calls `PATCH /api/v1/presenters/:id/status` with `{ "status": "active" }`.
2. Gateway re-enables access; existing credentials become usable again.
3. BOP updates stored status.

## Revoke presenter

1. BOP calls `DELETE /api/v1/presenters/:id`.
2. Gateway immediately disconnects active connection (if any) and deletes the presenter account and associated account information from its database.
3. BOP deletes its encrypted stored password and broadcast access record for that user.

## Regenerate password

1. BOP calls `POST /api/v1/presenters/:id/regenerate-password`.
2. Gateway generates a new secure password, replaces the Argon2id hash, immediately invalidates the old password, disconnects active connection if present, and returns the new password once.
3. BOP encrypts and stores the replacement password (replacing previous value).
4. User can view and copy the new password from BOP.

BOP must never attempt to retrieve the existing password from the gateway.

## Queue and system visibility

- `GET /api/v1/queue`: current LIVE/NEXT presenters, usernames/IDs/display names, connection timestamps, role, mount/content-type, occupancy/capacity
- `GET /api/v1/status`: gateway health/online info, uptime/version, queue summary, source endpoint config
- `GET /api/v1/events`: recent connection/authentication/account-management/error events for audit/operational views (no secrets)

## Error handling guidance for BOP

- **401 unauthorized:** invalid/missing API key or gateway API key not configured
- **400 bad_request:** validation errors (inspect `error.details`)
- **404 not_found:** unknown presenter ID (may have been revoked/deleted)
- **409 conflict:** username taken, idempotency payload mismatch, or in-progress duplicate create
- **429 too_many_requests:** back off and retry later
- **5xx:** transient server issue; retry with backoff (safe for idempotent reads; use idempotency key for create)

## Security requirements for BOP

- Store gateway API key and any presenter passwords in encrypted secret storage
- Never log plaintext presenter passwords or gateway API keys
- Display credentials to users only over authenticated, authorized, TLS-protected BOP sessions
- Use least-privilege access controls for who can view/copy/regenerate/revoke broadcast credentials
- Audit BOP-side credential access and management actions

## Presenter connection details (for BOP UI/help)

- Host: `broadcast.roadsideradio.co.uk`
- Port: `8005`
- Protocol: Icecast 2 source (PUT/SOURCE compatible)
- Mountpoint: `/live` (recommended/default)
- Username/password: per-presenter credentials provisioned via gateway/BOP
- Queue: first connected = LIVE, second = NEXT, third rejected while full; promotion automatic on disconnect
