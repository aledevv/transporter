import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Dev-only previews of single components (?preview=<name>), stripped from production builds
const preview = import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview');
const PREVIEWS = import.meta.env.DEV ? {
    'sheet-review': () => import('./preview/SheetReviewPreview.jsx'),
    map: () => import('./preview/MapPreview.jsx'),
} : {};
const Preview = preview && PREVIEWS[preview] ? React.lazy(PREVIEWS[preview]) : null;

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        {Preview
            ? <React.Suspense fallback={null}><Preview /></React.Suspense>
            : <App />}
    </React.StrictMode>,
)
