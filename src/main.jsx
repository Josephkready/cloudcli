import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
// KaTeX's stylesheet is deliberately NOT imported here: it is ~18.6 KB of the
// render-blocking bundle for a feature most sessions never hit. It now ships in
// the lazily-imported `shared/markdown/mathRuntime` chunk instead (issue #269).

// Initialize i18n
import './i18n/config.js'

// Register service worker for PWA + Web Push support.
// This is the ONLY registration site (#372) — index.html used to carry a second
// inline copy on `window.load`. If registration ever moves, move it, don't add.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js')
    // Success was logged by the index.html copy this replaced. Kept, at debug,
    // because "did the worker register?" is the first question for any push or
    // install bug and nothing else in the app reports it.
    .then(registration => {
      console.debug('Service worker registered, scope:', registration.scope);
    })
    .catch(err => {
      console.warn('Service worker registration failed:', err);
    });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
