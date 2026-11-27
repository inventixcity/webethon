#!/usr/bin/env bash
# Creates or updates the Render web service `invigil-api` from the GHCR image, sets its environment
# from .env.production, triggers a deploy and waits until it is live. Idempotent; safe to re-run.
#
#   bash deploy/render/deploy.sh [image-tag]      # default tag: latest
#
# Needs curl and node. Reads .env.production at the repository root (gitignored). Besides the app
# secrets it needs RENDER_API_KEY (Render > Account settings > API keys). Optional:
#   RENDER_OWNER_ID                 workspace id (tea-...); defaults to the first one the key can see
#   RENDER_REGISTRY_CREDENTIAL_ID   only if the GHCR package is private (rcr-...)
#   RENDER_REGION                   default singapore
#   RENDER_PLAN                     default free
# Secrets never appear on a command line: curl reads the auth header and JSON bodies from 0600 files.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
SERVICE_NAME="invigil-api"
IMAGE_REPO="ghcr.io/inventixcity/invigil-api"
TAG="${1:-latest}"
API="https://api.render.com/v1"

[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

WORK="$(mktemp -d)"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
umask 077

# ---------------------------------------------------------------- read and check .env.production
# Node parses the file (no `source`, so `$`, `&` and quotes in values are safe), validates the
# production secrets exactly as the API does at startup, and writes:
#   $WORK/auth     the Authorization header line for curl -H @file
#   $WORK/env.json the full env-var list for the service
#   $WORK/settings owner id, credential id, region, plan (one per line, may be empty)
node - "$ENV_FILE" "$WORK" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [file, work] = process.argv.slice(2);
const env = {};
for (const raw of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) continue;
  let value = match[2];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  env[match[1]] = value;
}
const problems = [];
const need = (key, test, message) => {
  if (!env[key]) problems.push(`${key} is missing`);
  else if (test && !test(env[key])) problems.push(`${key}: ${message}`);
};
need("RENDER_API_KEY");
need("DATABASE_URL", (v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// URL (use the Supabase session pooler, port 5432)");
need("APP_ORIGIN", (v) => /^https:\/\/[^/]+$/.test(v), "must be the https web origin with no path, e.g. https://invigil.vercel.app");
need("PROXY_SECRET", (v) => v.length >= 32, "must be at least 32 characters (and identical on Vercel)");
need("CODE_PEPPER", (v) => v.length >= 32, "must be at least 32 characters");
need("EXAM_LEASE_KEY", (v) => v.length >= 32, "must be at least 32 characters");
need("RESULT_SIGNING_KEY", (v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v.trim()) && Buffer.from(v.trim(), "base64").length === 32, "must be base64 of exactly 32 bytes (openssl rand -base64 32)");
need("MFA_ENCRYPTION_KEY", (v) => Buffer.from(v.trim(), "base64").length === 32, "must be base64 of exactly 32 bytes (openssl rand -base64 32)");
need("EMAIL_FROM");
if (!env.SMTP_URL && !env.RESEND_API_KEY) problems.push("set SMTP_URL or RESEND_API_KEY");
if (env.DATABASE_URL && /:6543\//.test(env.DATABASE_URL)) {
  problems.push("DATABASE_URL uses the transaction pooler (6543); use the session pooler (5432), which supports prepared statements");
}
if (problems.length) {
  console.error(`.env.production is not ready:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
const fixed = {
  APP_ENV: "production",
  RUN_MIGRATIONS: "true",
  TRUSTED_PROXY_HOPS: "1",
  PORT: "8080",
  BIND_ADDR: "0.0.0.0:8080",
  METRICS_ADDR: "127.0.0.1:9090",
  DATABASE_MAX_CONNECTIONS: "8",
  RUST_LOG: "info,sqlx=warn",
};
const passthrough = [
  "DATABASE_URL", "APP_ORIGIN", "PROXY_SECRET", "CODE_PEPPER", "EXAM_LEASE_KEY", "RESULT_SIGNING_KEY",
  "MFA_ENCRYPTION_KEY", "SMTP_URL", "RESEND_API_KEY", "EMAIL_FROM", "ALLOWED_ORIGINS",
  "AI_API_KEY", "AI_BASE_URL", "AI_MODEL",
];
const vars = Object.entries(fixed).map(([key, value]) => ({ key, value }));
for (const key of passthrough) if (env[key]) vars.push({ key, value: env[key] });
fs.writeFileSync(path.join(work, "auth"), `Authorization: Bearer ${env.RENDER_API_KEY}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(work, "env.json"), JSON.stringify(vars), { mode: 0o600 });
fs.writeFileSync(
  path.join(work, "settings"),
  [env.RENDER_OWNER_ID ?? "", env.RENDER_REGISTRY_CREDENTIAL_ID ?? "", env.RENDER_REGION ?? "singapore", env.RENDER_PLAN ?? "free"].join("\n") + "\n",
);
console.log(`Environment OK: ${vars.length} variables (${vars.map((v) => v.key).join(", ")})`);
NODE

{ read -r OWNER_ID; read -r CREDENTIAL_ID; read -r REGION; read -r PLAN; } <"$WORK/settings"
IMAGE="$IMAGE_REPO:$TAG"

# ---------------------------------------------------------------- helpers
# render METHOD PATH [BODY_FILE] -> response body on stdout; exits with the API error on failure.
render() {
  local method="$1" path="$2" body="${3:-}" out="$WORK/response" status
  local args=(-sS -X "$method" -H @"$WORK/auth" -H "Accept: application/json" -o "$out" -w "%{http_code}")
  if [[ -n "$body" ]]; then
    args+=(-H "Content-Type: application/json" --data-binary @"$body")
  fi
  status="$(curl "${args[@]}" "$API$path")"
  if [[ "$status" != 2* ]]; then
    echo "Render API $method $path failed with HTTP $status:" >&2
    cat "$out" >&2
    echo >&2
    exit 1
  fi
  cat "$out"
}

# json EXPRESSION < input -> evaluates a JS expression with `d` bound to the parsed stdin JSON.
json() {
  node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => {
      const d = text ? JSON.parse(text) : null;
      const value = eval(process.argv[1]);
      process.stdout.write(value === undefined || value === null ? "" : String(value));
    });
  ' "$1"
}

# ---------------------------------------------------------------- owner and existing service
if [[ -z "$OWNER_ID" ]]; then
  OWNER_ID="$(render GET "/owners?limit=20" | json 'd[0] && d[0].owner.id')"
  [[ -n "$OWNER_ID" ]] || { echo "The API key can see no Render workspace; set RENDER_OWNER_ID" >&2; exit 1; }
fi
echo "Render workspace: $OWNER_ID"

SERVICE_ID="$(render GET "/services?name=$SERVICE_NAME&ownerId=$OWNER_ID&limit=20" \
  | json "(d.find((x) => x.service.name === '$SERVICE_NAME') || {service: {}}).service.id")"

IMAGE_JSON="$(node -e '
  const [owner, path, credential] = process.argv.slice(1);
  const image = { ownerId: owner, imagePath: path };
  if (credential) image.registryCredentialId = credential;
  process.stdout.write(JSON.stringify(image));
' "$OWNER_ID" "$IMAGE" "$CREDENTIAL_ID")"

if [[ -z "$SERVICE_ID" ]]; then
  # ---------------------------------------------------------------- create (deploys on creation)
  echo "Creating $SERVICE_NAME from $IMAGE ($PLAN, $REGION)"
  node -e '
    const fs = require("node:fs");
    const [envFile, out, owner, name, image, region, plan] = process.argv.slice(1);
    fs.writeFileSync(out, JSON.stringify({
      type: "web_service",
      name,
      ownerId: owner,
      image: JSON.parse(image),
      envVars: JSON.parse(fs.readFileSync(envFile, "utf8")),
      serviceDetails: {
        runtime: "image",
        plan,
        region,
        healthCheckPath: "/healthz",
        numInstances: 1,
      },
    }), { mode: 0o600 });
  ' "$WORK/env.json" "$WORK/create.json" "$OWNER_ID" "$SERVICE_NAME" "$IMAGE_JSON" "$REGION" "$PLAN"
  CREATED="$(render POST "/services" "$WORK/create.json")"
  SERVICE_ID="$(printf '%s' "$CREATED" | json 'd.service.id')"
  DEPLOY_ID="$(printf '%s' "$CREATED" | json 'd.deployId')"
else
  # ---------------------------------------------------------------- update env and image, then deploy
  echo "Updating $SERVICE_NAME ($SERVICE_ID) to $IMAGE"
  render PUT "/services/$SERVICE_ID/env-vars" "$WORK/env.json" >/dev/null
  node -e '
    const fs = require("node:fs");
    const [out, image] = process.argv.slice(1);
    fs.writeFileSync(out, JSON.stringify({ image: JSON.parse(image), serviceDetails: { healthCheckPath: "/healthz" } }));
  ' "$WORK/patch.json" "$IMAGE_JSON"
  render PATCH "/services/$SERVICE_ID" "$WORK/patch.json" >/dev/null
  node -e '
    require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ imageUrl: process.argv[2] }));
  ' "$WORK/deploy.json" "$IMAGE"
  DEPLOY_ID="$(render POST "/services/$SERVICE_ID/deploys" "$WORK/deploy.json" | json 'd.id')"
fi

URL="$(render GET "/services/$SERVICE_ID" | json 'd.serviceDetails && d.serviceDetails.url')"
echo "Service: $SERVICE_ID  URL: ${URL:-unknown}"

# ---------------------------------------------------------------- wait for the deploy
if [[ -n "${DEPLOY_ID:-}" ]]; then
  echo "Deploy $DEPLOY_ID started; waiting (up to 15 minutes)"
  for _ in $(seq 1 90); do
    STATUS="$(render GET "/services/$SERVICE_ID/deploys/$DEPLOY_ID" | json 'd.status')"
    case "$STATUS" in
      live)
        echo "Deploy is live."
        break
        ;;
      *failed|canceled|deactivated)
        echo "Deploy ended with status: $STATUS. Check the logs in the Render dashboard." >&2
        exit 1
        ;;
    esac
    printf '  %s\n' "$STATUS"
    sleep 10
  done
fi

if [[ -n "$URL" ]]; then
  echo "Health: $(curl -fsS --retry 3 --retry-delay 10 --max-time 60 "$URL/healthz" || echo unreachable)"
  echo
  echo "Next:"
  echo "  vercel env add API_ORIGIN production      # value: $URL"
  echo "  gh variable set API_HEALTH_URL --body '$URL/healthz'"
fi
