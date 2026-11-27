#!/usr/bin/env bash
set -euo pipefail
GROUP="${AZURE_RESOURCE_GROUP:-invigil-rg}"
az containerapp exec --resource-group "$GROUP" --name invigil-api --command "/app/api seed-demo"
