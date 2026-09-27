/**
 * The `~/.cloudcli/local-server.json` marker file: written on startup so other
 * host-local tools (the `cloudcli status` CLI, browser-extension helpers) can
 * discover a running dev/local server without guessing its port, and removed
 * on clean shutdown. Extracted from server/index.js's startServer/shutdown
 * flow so the read/write logic can be unit-tested against a scratch directory
 * instead of the real `~/.cloudcli`.
 */
import { promises as fsPromises } from 'fs';
import path from 'path';

export type LocalServerMarker = {
  pid: number;
  host: string;
  port: number;
  url: string;
  installMode: string;
  appRoot: string;
  updatedAt: string;
};

/** Path to the marker file under the given home directory. */
export function getLocalServerMarkerPath(homeDir: string): string {
  return path.join(homeDir, '.cloudcli', 'local-server.json');
}

/** Writes the marker file, stamping `updatedAt` at call time. */
export async function writeLocalServerMarker(
  markerPath: string,
  marker: Omit<LocalServerMarker, 'updatedAt'>,
): Promise<void> {
  const payload: LocalServerMarker = {
    ...marker,
    updatedAt: new Date().toISOString(),
  };

  await fsPromises.mkdir(path.dirname(markerPath), { recursive: true });
  await fsPromises.writeFile(markerPath, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * Removes the marker file, but only if it still belongs to this process — a
 * newer server instance (already started, already wrote its own marker) must
 * not have its marker deleted by an older instance shutting down after it.
 */
export async function removeLocalServerMarker(markerPath: string, pid: number): Promise<void> {
  try {
    const raw = await fsPromises.readFile(markerPath, 'utf8');
    const marker = JSON.parse(raw);
    if (marker.pid && marker.pid !== pid) return;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
  }

  try {
    await fsPromises.unlink(markerPath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn('[WARN] Could not remove local server marker:', error.message);
    }
  }
}
