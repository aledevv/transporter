#!/bin/bash
echo "🔐 Logout e nuova autenticazione con Google Cloud..."
gcloud auth revoke --all 2>/dev/null
gcloud auth login

firebase logout
firebase login