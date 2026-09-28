// Graceful shutdown (architecture v0.3 §11): "On SIGTERM, the process stops
// accepting requests, releases any held locks (their runs are marked ABANDONED)
// and calls mongoose.disconnect()."
//
// Order matters: the sync service marks its runs ABANDONED *before* releasing the
// leases, so nothing still in flight can finish a run as SUCCESS afterwards
// (syncRunRepo.finish only moves RUNNING runs). The returned function is
// idempotent: every call returns the same promise.

export function createShutdown({ server, sync, disconnect, closeClient = () => {}, log = () => {}, exit = () => {}, timeoutMs = 10_000 }) {
  let done = null;
  return function shutdown(signal = 'shutdown') {
    done ??= (async () => {
      log(`${signal} received, shutting down`);
      const force = setTimeout(() => {
        log('shutdown timed out; exiting');
        exit(1);
      }, timeoutMs);
      force.unref?.();
      let code = 0;
      try {
        const closed = server ? new Promise((resolve) => server.close(() => resolve())) : Promise.resolve();
        server?.closeIdleConnections?.();
        const { abandoned } = await sync.shutdown();
        if (abandoned.length) log(`abandoned ${abandoned.length} running sync run(s): ${abandoned.join(', ')}`);
        closeClient();
        await closed;
        await disconnect();
      } catch (err) {
        code = 1;
        log(`shutdown error: ${err?.message ?? err}`);
      } finally {
        clearTimeout(force);
      }
      exit(code);
      return code;
    })();
    return done;
  };
}
