#!/usr/bin/env bash
# Uniform deploy script for all 3 Cloud Run services (chatbot-webhook,
# chatbot-webhook-sg, chatbot-webhook-staging).
#
# Why this exists (2026-10-22 incident): a prior one-off
# `gcloud run services update chatbot-webhook-sg --set-env-vars MAILER_BASE_URL=...`
# wiped every other env var on that service, because --set-env-vars REPLACES
# the entire set instead of merging. That silently broke SG prod's webhook
# signature verification and outbound sends for 10 days before a real
# customer report surfaced it, since SG's traffic is very low.
#
# This script makes every deploy re-sync ALL of the current directory's
# .env vars onto the service via --update-env-vars (the MERGING flag),
# every single time, so this class of drift becomes self-healing instead
# of a silent, one-time-only correct state that can be wiped by a later
# unrelated change. It never uses --set-env-vars.
#
# Usage: scripts/deploy.sh <service-name> [region]
# Run from the repo directory whose .env you want synced (e.g. ~/CodingProjects/PHChatBot,
# ~/CodingProjects/PHChatBotSG, ~/CodingProjects/PHChatBot-staging) — each
# directory's own .env is used, never copied from a sibling directory.

set -euo pipefail

SERVICE_NAME="${1:?Usage: scripts/deploy.sh <service-name> [region]}"
REGION="${2:-asia-southeast1}"
ENV_FILE=".env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found in $(pwd) — refusing to deploy without syncing env vars." >&2
  exit 1
fi

# Unit separator (0x1F) — a delimiter that cannot realistically appear in any
# real secret/URL/email value, unlike a comma or '@' (an email address broke
# an earlier '@' delimiter attempt during the 2026-10-22 fix).
D=$'\x1f'

env_pairs=""
while IFS= read -r line || [[ -n "$line" ]]; do
  # Skip blank lines and comments.
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  # Must contain '=' to be a KEY=VALUE line.
  [[ "$line" != *"="* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  key="$(echo -n "$key" | xargs)" # trim whitespace from key
  [[ -z "$key" ]] && continue
  # Strip one layer of surrounding quotes, matching dotenv's own behavior —
  # otherwise a quoted .env value would deploy with literal quote characters
  # baked in, which the app never sees locally (dotenv strips them).
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value#\"}"
    value="${value%\"}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value#\'}"
    value="${value%\'}"
  fi
  if [[ -n "$env_pairs" ]]; then
    env_pairs="${env_pairs}${D}${key}=${value}"
  else
    env_pairs="${key}=${value}"
  fi
done < "$ENV_FILE"

if [[ -z "$env_pairs" ]]; then
  echo "ERROR: no KEY=VALUE pairs parsed from $ENV_FILE — refusing to deploy." >&2
  exit 1
fi

echo "Deploying $SERVICE_NAME (region: $REGION) with env vars synced from $(pwd)/$ENV_FILE ..."
echo "(values are never printed — only the deploy command runs with them)"

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region="$REGION" \
  --update-env-vars="^${D}^${env_pairs}"

echo "Done. Verifying env var count on the deployed service..."
DEPLOYED_COUNT=$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format=json \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)['spec']['template']['spec']['containers'][0].get('env', [])))")
LOCAL_COUNT=$(echo -n "$env_pairs" | tr "$D" '\n' | grep -c '=' || true)
echo "Local .env pairs: $LOCAL_COUNT | Deployed env vars: $DEPLOYED_COUNT"
if [[ "$DEPLOYED_COUNT" -lt "$LOCAL_COUNT" ]]; then
  echo "WARNING: deployed count is LOWER than local .env count — something may not have applied. Investigate before trusting this deploy." >&2
fi
