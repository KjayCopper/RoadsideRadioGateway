# RoadsideRadioGateway

Production-ready presenter gateway for **Roadside Radio**. It replaces Liquidsoap as the public presenter connection endpoint, accepts standard Icecast-compatible source connections, authenticates presenters, enforces a strict FIFO queue (1 LIVE + 1 NEXT), and forwards only live presenter audio internally to Liquidsoap. Designed from day one for future control by a Broadcast Operations Platform (BOP) via a documented server-to-server API.

- **Repository name:** `RoadsideRadioGateway`
- **Expected image:** `ghcr.io/OWNER/roadsideradiogateway:latest` (replace `OWNER` with your GitHub username or organisation)

> **No admin UI:** Management is performed through the authenticated REST API (suitable for Cosmos Cloud / BOP control). BOP is not built by this project and is not a dependency.

## Features

- Icecast-compatible source ingress on public port **8005** (PUT and SOURCE methods, HTTP Basic auth)
- Independent presenter account system (SQLite, Argon2id password hashing)
- Secure random password generation on create/regenerate (returned once to the authenticated requester)
- Strict FIFO presenter queue: **LIVE** and **NEXT** only; third connection rejected
- Immediate promotion on disconnect/suspend/revoke; AutoDJ resumes when no presenter is live (via Liquidsoap fallback)
- Gateway-controlled forwarding to Liquidsoap over private Docker networking (no internal ports exposed publicly)
- Authenticated BOP-ready REST API with idempotent presenter creation
- Persistent SQLite storage, health checks, structured logging with secret redaction
- Docker image build + GHCR publishing via GitHub Actions

## Architecture

1. **Public source endpoint (TCP/HTTP, port 8005):** Implements Icecast-compatible source handling. Presenters authenticate with individual credentials before queue allocation.
2. **Queue manager (in-memory):** Enforces max 2 presenters in arrival order (FIFO). Duplicate presenter connections rejected by default. Queue state is cleared on restart.
3. **Audio forwarding:** The LIVE presenter's stream is forwarded to Liquidsoap's internal Harbor input (`input.harbor`) over the private Docker network. The NEXT presenter remains connected to the gateway and their incoming audio is drained/discarded (not buffered/forwarded) so promotion has no accumulated delay and queued audio never reaches the public stream.
4. **Liquidsoap integration:** Liquidsoap receives the gateway-fed live source and uses `fallback([presenter_live, autodj])` to select presenter or AutoDJ, preserving the existing Icecast output and public `/live` mount.
5. **Management API (HTTP, port 3000, internal):** Authenticated server-to-server API for presenter/queue/status/event operations (and future BOP). Keep this port off the public internet; expose only to trusted controllers/networks.

### Audio forwarding design (investigated)

Preferred spec arrangement considered: two private presenter slots in Liquidsoap with gateway allocation and Liquidsoap-side live selection. A naive `fallback([slot1, slot2, autodj])` does not implement FIFO promotion correctly after the first slot frees (a newly connected presenter could preempt the already-live promoted slot depending on allocation), and Liquidsoap does not automatically know gateway queue intent. To guarantee strict FIFO promotion, no queued audio on-air, and zero promotion delay, this implementation uses **gateway-authoritative queueing** with a single internal live feed to Liquidsoap Harbor. The gateway consumes/drains NEXT audio to keep the encoder connected without buffering. This is reliable, preserves protocol compatibility, and meets all queue/latency/on-air requirements. The exact Liquidsoap 2.5.x integration snippet is provided in [`liquidsoap/presenter-gateway.liq`](liquidsoap/presenter-gateway.liq).

## Repository structure

```text
.
├─ .github/workflows/docker-publish.yml   # GHCR build/publish workflow
├─ docs/
│  ├─ API.md                              # REST API documentation
│  ├─ BOP_INTEGRATION.md                  # Future BOP integration guide
│  └─ DEPLOYMENT.md                       # Deployment, Cosmos Cloud, networking, ops
├─ liquidsoap/
│  └─ presenter-gateway.liq               # Liquidsoap 2.5.x integration snippet
├─ src/
│  ├─ api/                                # REST API app, auth middleware, routes
│  ├─ config/                             # Environment/config loading
│  ├─ db/                                 # SQLite init and repositories
│  ├─ logging/                            # Structured logger (redaction)
│  ├─ protocol/                           # Icecast-compatible source server
│  ├─ services/                           # Auth, presenters, queue, forwarding, events
│  └─ utils/                              # Crypto/helpers/errors
├─ tests/                                 # Automated tests (unit/integration/protocol)
├─ .dockerignore
├─ .env.example
├─ .gitignore
├─ docker-compose.yml
├─ Dockerfile
├─ package.json
└─ README.md
```

## Requirements

- Node.js LTS (>= 20) for local development/testing
- Docker / Docker Compose for containerized deployment
- Existing infrastructure (must remain operational): `KGM-Icecast`, `KGM-Liquidsoap` (rolling 2.5.x), public `radio.roadsideradio.co.uk` and `/live` mount, `broadcast.roadsideradio.co.uk:8005`

## Local development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy environment template and configure:
   ```bash
   cp .env.example .env
   ```
   Set strong values for `SESSION_SECRET`, `BOP_API_KEY`, and `LIQUIDSOAP_PASSWORD`. For local-only testing without Liquidsoap forwarding you can point Liquidsoap settings to a test harbor or run integration tests that mock/provide a sink as applicable.
3. Start the gateway:
   ```bash
   npm start
   ```
   - Source ingress: `http://0.0.0.0:8005`
   - Management API/health: `http://0.0.0.0:3000` (`GET /healthz`)

### Tests

```bash
npm test
```
Run specific suites with `npm run test:unit` or `npm run test:integration` if present. Tests must pass before deployment/port cutover. See [Testing & verification](#testing--verification).

### Docker build (local)

```bash
docker build -t roadsideradiogateway:local .
```

## Configuration

See [`.env.example`](.env.example) for all variables. Key settings:

| Variable | Purpose |
|---|---|
| `GATEWAY_HOST` / `GATEWAY_PORT` | Public presenter source listener (default `0.0.0.0:8005`) |
| `ADMIN_HOST` / `ADMIN_PORT` | Management API listener (default `0.0.0.0:3000`, keep private) |
| `DATA_DIR` / `DATABASE_PATH` | Persistent SQLite storage (mount a volume) |
| `BOP_API_KEY` | Strong server-to-server API key for BOP/Cosmos control |
| `LIQUIDSOAP_HOST` / `LIQUIDSOAP_PORT` / `LIQUIDSOAP_MOUNT` / `LIQUIDSOAP_USER` / `LIQUIDSOAP_PASSWORD` | Internal Harbor target on private Docker network |
| `ALLOW_DUPLICATE_PRESENTER_CONNECTIONS` | Default `false` (reject duplicates) |
| `TRUST_PROXY` | Set `true` only when behind a trusted reverse proxy |

Never commit secrets, `.env`, SQLite files, or logs.

## Presenter connection settings (broadcasting software)

Gateway endpoint: **`broadcast.roadsideradio.co.uk`**, port **`8005`**, protocol **Icecast 2** (source/PUT), mountpoint **`/live`** (or any mountpoint; gateway authenticates the presenter account). Use each presenter's individual **username** and **password**. TLS termination for source clients depends on your network/proxy setup; if exposing plain TCP 8005 publicly use network controls as appropriate and keep API on private networks.

> Exact UI field names vary slightly by encoder version; use Icecast/source mode.

### BUTT (broadcast using this tool)
- **Settings → Main → Server → Add**: Type `Icecast`, Address `broadcast.roadsideradio.co.uk`, Port `8005`, Password `<presenter password>`, Icecast mountpoint `/live`, Icecast user `<presenter username>`
- **Audio**: match station requirements; gateway forwards audio without unnecessary transcoding

### Mixxx
- **Preferences → Live Broadcasting**: Type `Icecast 2`, Host `broadcast.roadsideradio.co.uk`, Port `8005`, Mount `/live`, Login `<presenter username>`, Password `<presenter password>`
- Enable live broadcasting and start; connection becomes LIVE if slot free, otherwise NEXT or rejected if full

### RadioBOSS
- **Settings → Broadcast → (+) Add encoder/connection**: Server type `Icecast 2`, Server `broadcast.roadsideradio.co.uk`, Port `8005`, Username `<presenter username>`, Password `<presenter password>`, Mount `/live`
- Use compatible encoding settings as required by your Liquidsoap pipeline

### AltaCast / Edcast-compatible
- **Add Encoder → Icecast2**: Server IP/Host `broadcast.roadsideradio.co.uk`, Port `8005`, Encoder password `<presenter password>`, Mountpoint `/live`, Username `<presenter username>` (if supported/configured)
- Ensure source/encoder mode is Icecast2 (not Shoutcast v1 unless explicitly configured)

## Queue behavior

- Max 2 presenters: **LIVE** and **NEXT** (FIFO by actual connection arrival)
- 3rd connection rejected while both slots occupied
- Duplicate simultaneous connections for same presenter rejected by default
- On LIVE disconnect/revoke/suspend: NEXT promoted immediately
- On last disconnect: queue empty and Liquidsoap falls back to AutoDJ
- On gateway restart: all connections/queue positions cleared (empty queue)

## Liquidsoap integration (2.5.x)

See [`liquidsoap/presenter-gateway.liq`](liquidsoap/presenter-gateway.liq) for the exact snippet. Summary:
- Bind Harbor on private network only, e.g. port `9001`, mount `/presenter`
- `presenter_live = input.harbor("presenter", port=9001, user="source", password="...")`
- `radio = fallback([presenter_live, autodj])` (presenter takes priority; AutoDJ resumes when unavailable)
- Keep existing `output.icecast` to `KGM-Icecast` with public mount `/live` unchanged
- Presenter stream metadata headers (e.g. `Ice-Name`, `Ice-Description`, `Ice-Genre`, `Ice-URL`, `ice-audio-info`) and Icecast-style now-playing updates (`/admin/metadata?mode=updinfo&mount=...&song=...`) received on port 8005 are forwarded through to Liquidsoap for the live presenter
- Validate with `liquidsoap --check yourscript.liq`

## Docker / Cosmos Cloud deployment

Detailed instructions: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Highlights:
- Image: `ghcr.io/OWNER/roadsideradiogateway:latest` (published by GitHub Actions)
- Publish/expose **only port 8005** publicly; keep **3000** private (API for Cosmos/BOP control)
- Attach container to the existing private Docker network used by `KGM-Liquidsoap` and `KGM-Icecast` (use service/container DNS names, not fixed IPs)
- Mount persistent volume at `/data` for SQLite
- Configure env vars/secrets in Cosmos Cloud (no secrets in image/repo)
- Health check: `GET http://<container>:3000/healthz`

## GitHub package (GHCR)

- Workflow: [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) builds with Buildx, authenticates with `GITHUB_TOKEN`, publishes to GHCR on pushes to `main` and version tags, emits `latest` (default branch) + semver/SHA tags, applies OCI labels/metadata, and uses GHA cache.
- **Find package:** GitHub repo → right sidebar **Packages** (or org/user Packages) → `roadsideradiogateway`
- **Visibility:** Package settings → **Change visibility** (Public or Private). Private requires authenticated pulls (`docker login ghcr.io` with a PAT/classic token with `read:packages` or appropriate access).
- **Pull:** `docker pull ghcr.io/OWNER/roadsideradiogateway:latest`
- **Update:** pull new image/tag in Cosmos Cloud and recreate/restart container (data persists via `/data` volume)

## API documentation

See [docs/API.md](docs/API.md). Includes authentication, all BOP endpoints, request/response schemas, idempotency behavior, and error codes.

## Future BOP integration

See [docs/BOP_INTEGRATION.md](docs/BOP_INTEGRATION.md) for the full grant/suspend/reactivate/revoke/regenerate workflows, password handling, retries, and security guidance.

## Security notes

- Argon2id password hashing; plaintext presenter passwords never stored and never logged
- Generated passwords returned only once (create/regenerate responses); idempotent replay never returns password
- Authenticated server-to-server API (strong API key), input validation, rate limiting, safe parameterized DB queries
- Run as non-root in container; internal Liquidsoap/API ports not for public exposure
- If BOP stores recoverable presenter passwords, it must use authenticated encryption (e.g. AES-256-GCM) with keys held outside its database (gateway never stores recoverable passwords)

## Backup and restore

- **Backup:** stop or quiesce writes if possible, then copy the persistent `/data` volume contents (at minimum `gateway.sqlite` and any WAL/SHM files: `gateway.sqlite-wal`, `gateway.sqlite-shm`). Store backups securely.
- **Restore:** stop container, restore files into the `/data` volume, ensure ownership/permissions are readable by the container user, start container. Active source connections/queue are not persisted across restarts by design.
- **Secrets:** back up `BOP_API_KEY`, Liquidsoap harbor credentials, and deployment env/secrets separately in your secret manager.

## Troubleshooting

- **Gateway won't start:** check logs for missing config/port bind errors/DB path permissions; ensure `/data` volume is writable.
- **Presenter auth fails:** verify username/password, account status is `active`, and client uses Icecast source mode with Basic auth fields.
- **503 queue full:** LIVE and NEXT occupied; retry when a slot frees.
- **409 duplicate:** same presenter already connected (default behavior).
- **No audio on stream:** confirm gateway can reach Liquidsoap harbor on private network/DNS name and port; verify `LIQUIDSOAP_*` credentials/mount match Liquidsoap config; check gateway and Liquidsoap logs.
- **Promotion not heard:** ensure only one live forward active (gateway-managed) and Liquidsoap fallback includes `presenter_live` before `autodj`.
- **API 401:** verify `Authorization: Bearer <BOP_API_KEY>` (or `X-API-Key`) and that key matches deployment config.
- **DB locked/errors:** persistent volume must be on a reliable local filesystem; avoid concurrent external writers.

## Testing & verification

Automated tests cover (as applicable in this environment): account/presenter CRUD logic, password generation/hashing/verification, idempotent create behavior, queue FIFO/promotion/rejection/disconnect/suspend/revoke/restart semantics, API auth and endpoint behavior, and protocol/forwarding integration where executable. Protocol-level source connection and end-to-end audio forwarding tests require reachable encoder/Liquidsoap test harness components; run all provided tests and integration scenarios in a staging environment before taking over port 8005. See `tests/` and the final completion report for executed results.

**Do not deploy or take over port 8005 until protocol and integration tests pass in your environment.**
