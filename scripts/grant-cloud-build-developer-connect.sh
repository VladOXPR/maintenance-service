#!/usr/bin/env bash
# Grants Cloud Build permission to read Git sources via Developer Connect.
# Fixes: Permission 'developerconnect.gitRepositoryLinks.get' denied (403)
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "No GCP project set. Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

if ! command -v gcloud &>/dev/null; then
  echo "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

echo "Project: ${PROJECT_ID} (${PROJECT_NUMBER})"
echo "Granting roles/developerconnect.user to ${BUILD_SA}"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${BUILD_SA}" \
  --role="roles/developerconnect.user"

echo "Done. Retry your Cloud Run deploy from GitHub, or run deploy from this machine:"
echo "  gcloud run deploy maintenance-service --source . --region us-central1 --allow-unauthenticated"
