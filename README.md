# CRM Service

Basic Express.js app configured for Google Cloud Run.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:8080

## Deploy to Cloud Run

```bash
gcloud run deploy crm-service --source . --region us-central1 --allow-unauthenticated
```

Or build and push the image yourself, then deploy the container to Cloud Run.
