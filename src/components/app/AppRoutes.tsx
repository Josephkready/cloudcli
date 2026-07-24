import { Route, Routes } from 'react-router-dom';

import AppContent from './AppContent';
import NotFound from './NotFound';

/**
 * The application's route table.
 *
 * Extracted from `App` so the routing itself is testable without standing up
 * the auth / websocket / plugins provider stack around it.
 */
export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<AppContent />} />
      <Route path="/session/:sessionId" element={<AppContent />} />
      {/*
        Without this, an unmatched path rendered literally nothing — no 404, no
        message, no way back. An unknown *session id* is different: it degrades
        gracefully inside AppContent, so only unknown routes land here.
      */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
