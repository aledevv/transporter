// API Configuration
// Uses relative URLs in production (works on Cloud Run)
// Uses localhost:5001 in development (matches backend port in app.py line 789)
const API_BASE_URL = import.meta.env.PROD ? '' : 'http://localhost:5001';

export default API_BASE_URL;
