#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/.env.production"
[[ -f "$ENV_FILE" ]] || { echo "Missing .env.production at repository root" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a
LOCATION="${AZURE_LOCATION:-southeastasia}"
APP_ORIGIN="${1:?usage: deploy.sh APP_ORIGIN [resource-group] [registry-name]}"
GROUP="${2:-invigil-rg}"
SUFFIX="${3:-$(printf '%s' "$GROUP" | sha256sum | cut -c1-8)}"
REGISTRY="invigilacr${SUFFIX}"
: "${DATABASE_URL:?required}" "${PROXY_SECRET:?required}" "${CODE_PEPPER:?required}" "${EXAM_LEASE_KEY:?required}" "${RESULT_SIGNING_KEY:?required}" "${MFA_ENCRYPTION_KEY:?required}" "${EMAIL_FROM:?required}"
[[ -n "${SMTP_URL:-}${RESEND_API_KEY:-}" ]] || { echo "Set SMTP_URL or RESEND_API_KEY in .env.production" >&2; exit 1; }
RG=(--resource-group "$GROUP")
az group create "${RG[@]}" --location "$LOCATION" --output none
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait
az acr show "${RG[@]}" --name "$REGISTRY" >/dev/null 2>&1 || az acr create "${RG[@]}" --name "$REGISTRY" --sku Basic --admin-enabled true --output none
SHA="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
az acr build "${RG[@]}" --registry "$REGISTRY" --image "invigil-api:$SHA" "$ROOT/backend"
az containerapp env show "${RG[@]}" --name invigil-env >/dev/null 2>&1 || az containerapp env create "${RG[@]}" --name invigil-env --location "$LOCATION" --output none
SECRETS=(database-url="$DATABASE_URL" proxy-secret="$PROXY_SECRET" code-pepper="$CODE_PEPPER" exam-lease-key="$EXAM_LEASE_KEY" result-signing-key="$RESULT_SIGNING_KEY" mfa-encryption-key="$MFA_ENCRYPTION_KEY" email-from="$EMAIL_FROM")
[[ -n "${SMTP_URL:-}" ]] && SECRETS+=(smtp-url="$SMTP_URL")
[[ -n "${RESEND_API_KEY:-}" ]] && SECRETS+=(resend-api-key="$RESEND_API_KEY")
for key in AI_API_KEY AI_BASE_URL AI_MODEL; do [[ -n "${!key:-}" ]] && { secret="$(printf '%s' "$key" | tr '[:upper:]_' '[:lower:]-')"; SECRETS+=("$secret=${!key}"); }; done
APP_EXISTS=false
az containerapp show "${RG[@]}" --name invigil-api >/dev/null 2>&1 && APP_EXISTS=true
MIGRATIONS=false
[[ "$APP_EXISTS" == true ]] || MIGRATIONS=true
ENV=(APP_ENV=production RUN_MIGRATIONS="$MIGRATIONS" APP_ORIGIN="$APP_ORIGIN" TRUSTED_PROXY_HOPS=1 DATABASE_URL=secretref:database-url PROXY_SECRET=secretref:proxy-secret CODE_PEPPER=secretref:code-pepper EXAM_LEASE_KEY=secretref:exam-lease-key RESULT_SIGNING_KEY=secretref:result-signing-key MFA_ENCRYPTION_KEY=secretref:mfa-encryption-key EMAIL_FROM=secretref:email-from)
[[ -n "${SMTP_URL:-}" ]] && ENV+=(SMTP_URL=secretref:smtp-url)
[[ -n "${RESEND_API_KEY:-}" ]] && ENV+=(RESEND_API_KEY=secretref:resend-api-key)
for key in AI_API_KEY AI_BASE_URL AI_MODEL; do
  [[ -n "${!key:-}" ]] || continue
  secret="$(printf '%s' "$key" | tr '[:upper:]_' '[:lower:]-')"
  env_name="$key"
  ENV+=("$env_name=secretref:$secret")
done
if az containerapp show "${RG[@]}" --name invigil-api >/dev/null 2>&1; then
 az containerapp secret set "${RG[@]}" --name invigil-api --secrets "${SECRETS[@]}" --output none
 az containerapp update "${RG[@]}" --name invigil-api --image "$REGISTRY.azurecr.io/invigil-api:$SHA" --set-env-vars "${ENV[@]}" --min-replicas 1 --max-replicas 3 --cpu 0.5 --memory 1.0Gi --output none
else
 az containerapp create "${RG[@]}" --name invigil-api --environment invigil-env --image "$REGISTRY.azurecr.io/invigil-api:$SHA" --registry-server "$REGISTRY.azurecr.io" --registry-username "$(az acr credential show "${RG[@]}" --name "$REGISTRY" --query username -o tsv)" --registry-password "$(az acr credential show "${RG[@]}" --name "$REGISTRY" --query 'passwords[0].value' -o tsv)" --ingress external --target-port 8080 --secrets "${SECRETS[@]}" --env-vars "${ENV[@]}" --min-replicas 1 --max-replicas 3 --cpu 0.5 --memory 1.0Gi --output none
fi
APP_JSON="$(mktemp)"
PATCH_JSON="$(mktemp)"
trap 'rm -f "$APP_JSON" "$PATCH_JSON"' EXIT
az containerapp show "${RG[@]}" --name invigil-api --output json >"$APP_JSON"
node - "$APP_JSON" "$PATCH_JSON" <<'NODE'
const fs = require('node:fs');
const app = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const properties = app.properties;
const container = properties.template.containers.find(({ name }) => name === 'invigil-api');
if (!container) throw new Error('invigil-api container is missing from the Container App');
container.probes = [
  {
    type: 'Readiness',
    httpGet: { path: '/readyz', port: 8080 },
    initialDelaySeconds: 10,
    periodSeconds: 10,
    timeoutSeconds: 5,
    failureThreshold: 3,
  },
  {
    type: 'Liveness',
    httpGet: { path: '/healthz', port: 8080 },
    initialDelaySeconds: 5,
    periodSeconds: 15,
    timeoutSeconds: 3,
    failureThreshold: 3,
  },
];
fs.writeFileSync(process.argv[3], JSON.stringify({
  location: app.location,
  // Revision settings only: show never returns secret values, so preserve non-revision settings.
  properties: { template: properties.template },
}));
NODE
APP_ID="$(az containerapp show "${RG[@]}" --name invigil-api --query id -o tsv)"
az rest --method patch --uri "https://management.azure.com${APP_ID}?api-version=2024-03-01" --body "@$PATCH_JSON" --output none
az containerapp show "${RG[@]}" --name invigil-api --query properties.configuration.ingress.fqdn -o tsv
