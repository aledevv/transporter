#!/bin/bash
echo "🚀 Deploy su Cloud Run in corso..."
gcloud run deploy transporter \
  --source . \
  --platform managed \
  --region europe-west6 \
  --allow-unauthenticated \
  --clear-base-image

firebase deploy --only hosting:busplan