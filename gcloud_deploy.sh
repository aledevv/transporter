#!/bin/bash
echo "🚀 Deploy su Cloud Run (progetto bus-plan-6d002)..."
gcloud run deploy transporter \
  --source . \
  --platform managed \
  --region europe-west6 \
  --allow-unauthenticated \
  --project bus-plan-6d002 \
  --clear-base-image

firebase deploy --only hosting:busplan