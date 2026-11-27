#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/.env.production"
[[ -f "$ENV_FILE" ]] || { echo "Missing .env.production at repository root" >&2; exit 1; }
set -a
source "$ENV_FILE"
set +a
GROUP="${AZURE_RESOURCE_GROUP:-invigil-rg}"
JOB="invigil-seed-demo"
: "${DATABASE_URL:?required}" "${PROXY_SECRET:?required}" "${CODE_PEPPER:?required}" "${EXAM_LEASE_KEY:?required}" "${RESULT_SIGNING_KEY:?required}" "${MFA_ENCRYPTION_KEY:?required}" "${EMAIL_FROM:?required}"
APP="$(az containerapp show --resource-group "$GROUP" --name invigil-api --output json)"
IMAGE="$(node -e 'const app=JSON.parse(process.argv[1]); process.stdout.write(app.properties.template.containers[0].image)' "$APP")"
ENVIRONMENT="$(node -e 'const app=JSON.parse(process.argv[1]); process.stdout.write(app.properties.managedEnvironmentId)' "$APP")"
APP_ORIGIN="${APP_ORIGIN:-$(node -e 'const app=JSON.parse(process.argv[1]); process.stdout.write(`https://${app.properties.configuration.ingress.fqdn}`)' "$APP")}"
REGISTRY="${IMAGE%%/*}"
REGISTRY_NAME="${REGISTRY%%.*}"
REGISTRY_USER="$(az acr credential show --resource-group "$GROUP" --name "$REGISTRY_NAME" --query username -o tsv)"
REGISTRY_PASSWORD="$(az acr credential show --resource-group "$GROUP" --name "$REGISTRY_NAME" --query 'passwords[0].value' -o tsv)"
SECRETS=(database-url="$DATABASE_URL" proxy-secret="$PROXY_SECRET" code-pepper="$CODE_PEPPER" exam-lease-key="$EXAM_LEASE_KEY" result-signing-key="$RESULT_SIGNING_KEY" mfa-encryption-key="$MFA_ENCRYPTION_KEY" email-from="$EMAIL_FROM")
[[ -n "${SMTP_URL:-}" ]] && SECRETS+=(smtp-url="$SMTP_URL")
[[ -n "${RESEND_API_KEY:-}" ]] && SECRETS+=(resend-api-key="$RESEND_API_KEY")
ENV_VARS=(APP_ENV=production RUN_MIGRATIONS=false APP_ORIGIN="$APP_ORIGIN" DATABASE_URL=secretref:database-url PROXY_SECRET=secretref:proxy-secret CODE_PEPPER=secretref:code-pepper EXAM_LEASE_KEY=secretref:exam-lease-key RESULT_SIGNING_KEY=secretref:result-signing-key MFA_ENCRYPTION_KEY=secretref:mfa-encryption-key EMAIL_FROM=secretref:email-from)
[[ -n "${SMTP_URL:-}" ]] && ENV_VARS+=(SMTP_URL=secretref:smtp-url)
[[ -n "${RESEND_API_KEY:-}" ]] && ENV_VARS+=(RESEND_API_KEY=secretref:resend-api-key)
if az containerapp job show --resource-group "$GROUP" --name "$JOB" >/dev/null 2>&1; then
  az containerapp job secret set --resource-group "$GROUP" --name "$JOB" --secrets "${SECRETS[@]}" --output none
  az containerapp job update --resource-group "$GROUP" --name "$JOB" --image "$IMAGE" --command /app/api --args seed-demo --env-vars "${ENV_VARS[@]}" --cpu 0.5 --memory 1.0Gi --output none
else
  az containerapp job create --resource-group "$GROUP" --name "$JOB" --environment "$ENVIRONMENT" --trigger-type Manual --replica-timeout 300 --replica-completion-count 1 --parallelism 1 --image "$IMAGE" --registry-server "$REGISTRY" --registry-username "$REGISTRY_USER" --registry-password "$REGISTRY_PASSWORD" --command /app/api --args seed-demo --secrets "${SECRETS[@]}" --env-vars "${ENV_VARS[@]}" --cpu 0.5 --memory 1.0Gi --output none
fi
az containerapp job start --resource-group "$GROUP" --name "$JOB" --output none
for _ in {1..70}; do
  STATUS="$(az containerapp job execution list --resource-group "$GROUP" --name "$JOB" --query '[0].properties.status' -o tsv)"
  case "$STATUS" in
    Succeeded) echo "Demo accounts seeded."; exit 0 ;;
    Failed) echo "Demo seed job failed." >&2; exit 1 ;;
  esac
  sleep 5
done
echo "Timed out waiting for the demo seed job." >&2
exit 1
