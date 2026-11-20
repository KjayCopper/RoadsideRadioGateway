# Roadside Radio Gateway -> Liquidsoap 2.5.x integration snippet
#
# Purpose:
# - Receive the LIVE presenter stream forwarded by RoadsideRadioGateway over a private Docker network.
# - Keep the existing public Icecast output and /live mount unchanged.
# - Fall back to the existing AutoDJ source when no presenter is live.
#
# Architecture notes:
# - The gateway is the authoritative FIFO queue manager (LIVE/NEXT, max 2 connected presenters).
# - The gateway forwards ONLY the currently live presenter to this single internal harbor input.
# - The NEXT presenter remains connected to the gateway (audio drained, not forwarded) so there is
#   no accumulated delay on promotion; on promotion the gateway immediately forwards the promoted
#   presenter's current audio to this same input.
# - This avoids unreliable queue-promotion behavior from naive dual-harbor fallback ordering and
#   guarantees that queued audio is never sent to the public stream.
#
# IMPORTANT:
# - Do not expose this harbor port publicly. Bind/listen only on the private Docker network.
# - Preserve your existing AutoDJ and output.icecast configuration for the public /live mount.
# - Merge this snippet into your existing Liquidsoap 2.5.x script; do not replace unrelated output config.

# --- Harbor settings (adjust as needed) ---
settings.harbor.bind_addrs := ["0.0.0.0"]

# Internal presenter input fed by RoadsideRadioGateway.
# Gateway env must match: LIQUIDSOAP_HOST=<liquidsoap-container>, LIQUIDSOAP_PORT=9001,
# LIQUIDSOAP_MOUNT=/presenter, LIQUIDSOAP_USER=source, LIQUIDSOAP_PASSWORD=<secret>
presenter_live = input.harbor(
  "presenter",
  port = 9001,
  user = "source",
  password = "CHANGE_ME_INTERNAL_HARBOR_PASSWORD",
  buffer = 2.0,
  max = 10.0
)
# Keep presenter_live fallible (available only when gateway is forwarding a live presenter).

# --- Example integration (preserve your existing autodj and output) ---
# Replace `autodj` below with your existing AutoDJ source variable/name.
# autodj = ... (existing playlist/request queue/fallback source) ...

# Live presenter takes priority; AutoDJ resumes when presenter source is unavailable.
radio = fallback(
  id = "presenter_fallback",
  track_sensitive = false,
  [presenter_live, autodj]
)

# --- KEEP YOUR EXISTING PUBLIC OUTPUT UNCHANGED ---
# Example only (do not duplicate/change your real output):
# output.icecast(
#   %mp3, # or your existing encoder/format
#   host = "KGM-Icecast",
#   port = 8000,
#   password = "EXISTING_SOURCE_PASSWORD",
#   mount = "/live",
#   name = "Roadside Radio",
#   description = "Roadside Radio live stream",
#   url = "https://radio.roadsideradio.co.uk",
#   public = false,
#   radio
# )
#
# Verification checklist after merge:
# - Liquidsoap starts without syntax errors under 2.5.x (`liquidsoap --check yourscript.liq`).
# - Harbor port 9001 is reachable only from the private Docker network (not published publicly).
# - With no presenter: AutoDJ is heard on existing public /live mount.
# - With LIVE presenter: gateway forwards audio and presenter is heard on /live.
# - With LIVE+NEXT presenters and LIVE disconnects: gateway promotes NEXT and audio continues.
# - When last presenter disconnects: AutoDJ resumes.
