# Deployment Guide (RoadsideRadioGateway)

## Overview

- **Container image:** `ghcr.io/OWNER/roadsideradiogateway:latest` (replace `OWNER`)
- **Public presenter ingress:** TCP port `8005` (only port that should be publicly exposed)
- **Management API:** HTTP port `3000` (keep private; for Cosmos Cloud/BOP control over trusted network/reverse proxy)
- **Persistent data:** `/data` (SQLite database) — mount a volume
- **Internal forwarding:** gateway connects to Liquidsoap Harbor over private Docker network (no public exposure)

## Prerequisites

- Existing containers/services remain operational: `KGM-Icecast`, `KGM-Liquidsoap` (2.5.x), public stream `radio.roadsideradio.co.uk` `/live`, AutoDJ
- Docker network shared privately between gateway, Liquidsoap, and Icecast (or at least gateway↔Liquidsoap). Use Docker DNS/service names.
- GHCR image available (or build locally for development)

## GitHub Actions & GHCR publishing

Workflow: `.github/workflows/docker-publish.yml`

- Triggers: push to `main`, version tags (`v*.*.*`), manual dispatch
- Builds with Docker Buildx, logs in to GHCR using `GITHUB_TOKEN`, pushes tags/labels/metadata
- Tags: `latest` on default branch, semver tags on version tags, branch/sha tags as configured
- Permissions: `contents: read`, `packages: write`
- No manual PAT required for normal Actions publishing

### Finding the package
1. Open the `RoadsideRadioGateway` repository on GitHub.
2. In the right sidebar, click **Packages** (or go to the owner/org Packages page).
3. Select `roadsideradiogateway` to view versions/tags.

### Package visibility
1. Open the package → **Package settings**.
2. Under **Danger Zone** / visibility, choose **Public** or **Private** per owner preference.
3. For private packages, configure image pull credentials on the VPS/Cosmos host (`docker login ghcr.io`).

### Pulling the image
```bash
docker pull ghcr.io/OWNER/roadsideradiogateway:latest
# or a specific version
docker pull ghcr.io/OWNER/roadsideradiogateway:v1.0.0
```

## Cosmos Cloud configuration

1. **Image:** `ghcr.io/OWNER/roadsideradiogateway:latest` (or pinned release tag)
2. **Restart policy:** unless-stopped / always
3. **Ports:**
   - Publish `8005:8005` (TCP) publicly for presenter encoders
   - Do **not** publish `3000` publicly unless strictly required; prefer private network access, VPN, or authenticated reverse proxy for API control
4. **Volumes:** mount persistent volume to `/data` (e.g. `roadsideradiogateway-data:/data`)
5. **Environment variables/secrets:** set from `.env.example` (use Cosmos secrets)
   - Required/important: `BOP_API_KEY`, `SESSION_SECRET` (random), `LIQUIDSOAP_HOST`, `LIQUIDSOAP_PORT`, `LIQUIDSOAP_MOUNT`, `LIQUIDSOAP_USER`, `LIQUIDSOAP_PASSWORD`, `GATEWAY_PUBLIC_URL`, `TRUST_PROXY` (if behind proxy)
6. **Networks:** attach to the existing private Docker network used by `KGM-Liquidsoap` (and `KGM-Icecast` if applicable). Set `LIQUIDSOAP_HOST` to the Liquidsoap container/service DNS name (e.g. `KGM-Liquidsoap`), not an IP.
7. **Health check:** HTTP GET `http://localhost:3000/healthz` inside container
8. **User:** image runs as non-root user; ensure `/data` volume is writable by container user (Docker named volumes typically fine)

### Example (docker-compose, adapt for Cosmos)

See root `docker-compose.yml`. Replace `OWNER`, external network name, and secrets. Do not commit real secrets.

## Liquidsoap configuration (KGM-Liquidsoap, 2.5.x)

1. Merge `liquidsoap/presenter-gateway.liq` into the existing Liquidsoap script without changing the existing Icecast output/public `/live` mount or AutoDJ behavior.
2. Set harbor password/user/port/mount to match gateway env (`LIQUIDSOAP_*`).
3. Ensure harbor bind is private (not publicly exposed) and reachable from gateway container.
4. Keep `fallback(track_sensitive=false, [presenter_live, autodj])` so presenter overrides AutoDJ and AutoDJ resumes when unavailable.
5. Validate syntax: `liquidsoap --check /path/to/script.liq`
6. Reload/restart Liquidsoap per your operational process.

## Networking & firewall

- **Public:** allow inbound TCP `8005` to gateway only (presenter encoders)
- **Private/internal:** allow gateway → Liquidsoap harbor port (e.g. `9001`) on Docker private network; do not publish harbor port on host/public interfaces
- **Management API:** restrict port `3000` to trusted controller/Cosmos/BOP networks; enforce HTTPS/TLS and API key auth
- Do not expose internal presenter input ports publicly
- Use Docker DNS/service names, never fixed container IPs

## Cutover plan (safe)

1. Deploy gateway container and configure Liquidsoap harbor integration on private network.
2. Run automated tests and staging protocol/integration tests (source connect, auth, queue FIFO, promotion, forwarding, AutoDJ fallback).
3. Confirm existing public stream/AutoDJ unaffected.
4. Only after tests pass, switch public presenter traffic/port `8005` to RoadsideRadioGateway.
5. Monitor logs, `/api/v1/status`, `/api/v1/queue`, and stream health.

## Updating the container

1. Pull new image/tag: `docker pull ghcr.io/OWNER/roadsideradiogateway:<tag-or-latest>`
2. Recreate container with same env vars and `/data` volume mounted (Cosmos: update image and redeploy/restart)
3. Verify `/healthz`, API status, and source connectivity
4. SQLite data persists across image updates when volume is preserved

## Operations

- **Logs:** container stdout/stderr (structured). No plaintext passwords, hashes, API keys, or session secrets are logged.
- **Events:** query `GET /api/v1/events` for recent connection/auth/account events
- **Queue/status:** `GET /api/v1/queue`, `GET /api/v1/status`
- **Restart behavior:** all active source connections and queue positions are cleared on restart (empty queue). AutoDJ should remain available via Liquidsoap fallback.

## Backup and restore

- Back up `/data/gateway.sqlite` (+ `-wal`/`-shm` if present) from the persistent volume
- Restore by replacing DB files in `/data` while container stopped, then start container
- Securely back up deployment secrets separately (`BOP_API_KEY`, Liquidsoap credentials)
