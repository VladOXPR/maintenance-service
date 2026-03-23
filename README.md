# Maintenance service

Basic Express.js app configured for Google Cloud Run.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:8080

## Deploy to Cloud Run

```bash
gcloud run deploy maintenance-service --source . --region us-central1 --allow-unauthenticated
```

Or build and push the image yourself, then deploy the container to Cloud Run.

## Cloud Run deploy from GitHub (Developer Connect 403)

If the build fails with `developerconnect.gitRepositoryLinks.get` / `IAM_PERMISSION_DENIED`, Cloud Build’s service account cannot read your linked GitHub repo. From a machine with [gcloud](https://cloud.google.com/sdk/docs/install) and Owner (or IAM Admin) on the project:

```bash
gcloud config set project YOUR_PROJECT_ID
./scripts/grant-cloud-build-developer-connect.sh
```

Or manually:

```bash
PROJECT_ID=YOUR_PROJECT_ID
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
  --role="roles/developerconnect.user"
```

To skip Git-linked builds entirely, deploy from your laptop (uploads source to Cloud Build; no Developer Connect fetch):

```bash
gcloud run deploy maintenance-service --source . --region us-central1 --allow-unauthenticated
```
