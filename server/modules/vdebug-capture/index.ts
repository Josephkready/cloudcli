// video-debugger Phase 1 (real-user flow capture). Mounted by server/index.js
// ahead of the global JSON parser: serves the recorder gate + /api/_vd/events.
export { createVdebugCaptureRouter, resolveVdebugCaptureConfig } from './vdebug-capture.routes.js';
