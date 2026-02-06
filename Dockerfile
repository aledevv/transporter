# Build stage for Frontend
FROM node:20-alpine as build

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ .
RUN npm run build

# Runtime stage for Backend
FROM python:3.9-slim

WORKDIR /app

# Install system dependencies if needed (e.g. for potential C++ compiled libraries)
# RUN apt-get update && apt-get install -y --no-install-recommends gcc g++ && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install gunicorn

COPY . .

# Copy built frontend from build stage
COPY --from=build /app/frontend/dist ./frontend/dist

# Expose port (Cloud Run sets PORT env var, usually 8080)
EXPOSE 8080

# Environment variables
ENV FLASK_ENV=production
ENV PYTHONUNBUFFERED=1

# Command to run the application
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 0 app:app
