import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Dev-only previews of single components (?preview=<name>), stripped from production builds
const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview');
const SheetReviewPreview = preview === 'sheet-review'
    ? React.lazy(() => import('./preview/SheetReviewPreview.jsx'))
    : null;

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        {SheetReviewPreview
            ? <React.Suspense fallback={null}><SheetReviewPreview /></React.Suspense>
            : <App />}
    </React.StrictMode>,
)
