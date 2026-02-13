#!/bin/bash
echo "🚀 Deploy su Cloud Run (progetto bus-plan-6d002)..."
gcloud run deploy transporter \
  --source . \
  --platform managed \
  --region europe-west6 \
  --allow-unauthenticated \
  --project bus-plan-6d002 \
  --memory 512Mi \
  --cpu 1 \
  --concurrency 80 \
  --min-instances 0 \
  --max-instances 3 \
  --no-cpu-throttling

firebase deploy --only hosting:busplan