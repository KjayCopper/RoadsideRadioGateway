# RoadsideRadioGateway REST API

Authenticated server-to-server API for BOP / Cosmos Cloud control.

- **Base URL:** `http://<gateway-admin-host>:3000/api/v1` (keep private; do not expose publicly)
- **Auth:** `Authorization: Bearer <BOP_API_KEY>` or `X-API-Key: <BOP_API_KEY>`
- **Content-Type:** `application/json` for request/response bodies
- **Transport:** Use HTTPS for all external communication (terminate TLS at a trusted reverse proxy/private ingress as appropriate)

> Generated presenter passwords are returned **only** in successful create and regenerate responses. They are never logged, never stored in recoverable form, and never returned by presenter retrieval/list endpoints.

## Common errors

| HTTP | code | Meaning |
|---:|---|---|
| 400 | `bad_request` | Invalid input/validation failure |
| 401 | `unauthorized` | Missing/invalid API credentials |
| 404 | `not_found` | Presenter/resource not found |
| 409 | `conflict` | Username exists, duplicate/idempotency conflict, or duplicate connection context where applicable |
| 429 | `too_many_requests` | Rate limit exceeded |
| 500 | `internal_error` | Server/database/configuration error |
| 503 | `service_unavailable` | Queue full for source connections (source protocol) or temporary service condition |

Error body:
```json
{ "error": { "code": "bad_request", "message": "...", "details": {} } }
```

## Presenters

### Create presenter
`POST /presenters`

Creates an active presenter, generates a cryptographically secure random password, stores only its Argon2id hash, and returns the password once.

**Headers:** `Idempotency-Key: <unique-key>` (recommended/required for safe retries)

**Body:**
```json
{
  "username": "presenter1",
  "displayName": "Presenter One",
  "externalUserRef": "bop-user-123"
}
```

**201 Created:**
```json
{
  "presenterId": "prs_...",
  "username": "presenter1",
  "displayName": "Presenter One",
  "status": "active",
  "externalUserRef": "bop-user-123",
  "createdAt": "2026-11-20T12:00:00.000Z",
  "lastConnectionAt": null,
  "lastPasswordChangeAt": "2026-11-20T12:00:00.000Z",
  "password": "GENERATED_PASSWORD_ONCE"
}
```

**Idempotency:** If retried with the same `Idempotency-Key` and same payload after a completed create, the gateway returns the same presenter information with `idempotentReplay: true` and `password: null` (plaintext is never stored/replayed). If the original password was lost, call **Regenerate password**. Reuse of the same key with a different payload returns **409**.

### List presenters
`GET /presenters`

**200 OK:** `{ "presenters": [ { "id": "...", "displayName": "...", "username": "...", "status": "active|suspended", "externalUserRef": "...", "createdAt": "...", "lastConnectionAt": "...", "lastPasswordChangeAt": "..." } ] }`

### Get presenter
`GET /presenters/:id`

**200 OK:** `{ "presenter": { ...no password/hash... } }`

### Update presenter status (suspend/reactivate)
`PATCH /presenters/:id/status`

**Body:** `{ "status": "suspended" }` or `{ "status": "active" }`

Behavior:
- `suspended`: prevents future connections and immediately disconnects any active connection; account/password hash preserved
- `active`: existing credentials become usable again

**200 OK:** `{ "presenter": { ... } }`

### Revoke presenter (delete)
`DELETE /presenters/:id`

Immediately disconnects if connected and permanently removes the presenter account (username, hash, status, associated account info) from the gateway database.

**200 OK:** `{ "revoked": true, "id": "prs_..." }`

### Regenerate password
`POST /presenters/:id/regenerate-password`

Generates a new password, replaces Argon2id hash, immediately invalidates old password, disconnects active connection if present, and returns the new password once.

**200 OK:**
```json
{
  "presenterId": "prs_...",
  "username": "presenter1",
  "status": "active",
  "lastPasswordChangeAt": "2026-11-20T12:05:00.000Z",
  "password": "NEW_GENERATED_PASSWORD_ONCE"
}
```

## Queue

### Get queue status
`GET /queue`

**200 OK:**
```json
{
  "live": {
    "presenterId": "prs_...",
    "username": "presenter1",
    "displayName": "Presenter One",
    "connectedAt": "2026-11-20T12:10:00.000Z",
    "role": "live",
    "mountpoint": "/live",
    "contentType": "audio/mpeg"
  },
  "next": null,
  "occupancy": 1,
  "capacity": 2
}
```
`live`/`next` are `null` when empty. Queue is FIFO by actual arrival order; max 2.

## System

### Get system status
`GET /status`

**200 OK:**
```json
{
  "gateway": { "online": true, "name": "RoadsideRadioGateway", "version": "1.0.0", "uptimeSeconds": 123, "timestamp": "..." },
  "queue": { "live": null, "next": null, "occupancy": 0, "capacity": 2 },
  "source": { "host": "0.0.0.0", "port": 8005, "publicUrl": "https://broadcast.roadsideradio.co.uk:8005" }
}
```

### Health check
`GET /healthz` (no auth, for container/orchestrator health checks)

**200 OK:** `{ "ok": true }`

## Events / logs (operational visibility)

### List recent events
`GET /events?limit=100&types=account_created,authentication_failed`

Returns recent gateway/audit events (authentication, connections, queue actions, account management, errors). Sensitive values (passwords, hashes, secrets, API keys) are never included.

**200 OK:** `{ "events": [ { "id": "evt_...", "type": "...", "level": "info|warn|error", "message": "...", "presenterId": null, "username": null, "details": {}, "createdAt": "..." } ] }`

## Source protocol (presenter ingress, port 8005)

- Icecast-compatible source connections: **HTTP PUT** (including `Expect: 100-continue`) and **SOURCE**
- HTTP Basic authentication using presenter username/password
- Authentication occurs before queue allocation
- Responses: **200/100** accepted (live or next), **401** invalid credentials/inactive, **409** duplicate active presenter connection (default), **503** queue full (live+next occupied)
- Source stream metadata headers (e.g. `Ice-Name`, `Ice-Description`, `Ice-Genre`, `Ice-URL`, `ice-audio-info`) are forwarded to the internal Liquidsoap input for the live stream
- Now-playing / song metadata updates are accepted on `GET` or `POST` `/admin/metadata` (Icecast-compatible, e.g. `mode=updinfo&mount=...&song=...`) with presenter Basic auth and forwarded to Liquidsoap for the current LIVE presenter
- Only LIVE audio is forwarded to Liquidsoap; NEXT audio is drained without forwarding/accumulation; queued audio never reaches the public stream
- On restart, all connections/queue state are cleared
