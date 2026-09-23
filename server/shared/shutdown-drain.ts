/**
 * Process-wide "shutting down" flag (issue #70, #535).
 *
 * Set once when SIGTERM/SIGINT starts the graceful drain. Lives in its own
 * dependency-free module so both the chat-run registry (which owns the drain)
 * and the notification orchestrator (which must not push "run failed" for a
 * run the shutdown itself killed) can read it without importing each other.
 */
let shutdownDraining = false;

export function markShutdownDraining(): void {
  shutdownDraining = true;
}

export function isShutdownDraining(): boolean {
  return shutdownDraining;
}

/** Test-only: clear the flag so a drain test cannot leak into later suites. */
export function resetShutdownDrainingForTests(): void {
  shutdownDraining = false;
}
