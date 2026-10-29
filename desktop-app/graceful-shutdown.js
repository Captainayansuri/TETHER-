function waitWithTimeout(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Graceful shutdown timed out');
      error.code = 'SHUTDOWN_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(operation), timeout])
    .finally(() => clearTimeout(timer));
}

function createGracefulShutdown({
  stopAccepting,
  notifyClients,
  stopQueueAdmission,
  drainQueue,
  closeTransfers,
  persistState,
  closeClients,
  forceCloseClients = () => {},
  forceCloseServer = () => {},
  timeoutMs,
  onError = () => {},
  onTimeout = () => {}
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Shutdown timeout must be a positive integer');
  }

  let shutdownPromise;

  async function runStep(name, operation) {
    try {
      await operation();
    } catch (error) {
      onError(name, error);
    }
  }

  return function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      let acceptingStopped;
      try {
        acceptingStopped = Promise.resolve(stopAccepting());
      } catch (error) {
        acceptingStopped = Promise.reject(error);
      }
      const acceptingResult = acceptingStopped.then(
        () => null,
        (error) => error
      );

      await runStep('notify_clients', notifyClients);
      await runStep('stop_queue_admission', stopQueueAdmission);

      try {
        await waitWithTimeout(drainQueue, timeoutMs);
      } catch (error) {
        if (error.code === 'SHUTDOWN_TIMEOUT') {
          onTimeout('drain_queue');
        } else {
          onError('drain_queue', error);
        }
      }

      try {
        await waitWithTimeout(closeClients, timeoutMs);
      } catch (error) {
        if (error.code === 'SHUTDOWN_TIMEOUT') {
          onTimeout('close_clients');
        } else {
          onError('close_clients', error);
        }
        await runStep('force_close_clients', forceCloseClients);
      }
      await runStep('close_transfers', closeTransfers);
      await runStep('persist_state', persistState);

      try {
        const closeError = await waitWithTimeout(() => acceptingResult, timeoutMs);
        if (closeError) onError('stop_accepting', closeError);
      } catch (error) {
        if (error.code === 'SHUTDOWN_TIMEOUT') {
          onTimeout('close_servers');
        } else {
          onError('close_servers', error);
        }
        await runStep('force_close_server', forceCloseServer);
      }
    })();
    return shutdownPromise;
  };
}

module.exports = { createGracefulShutdown };
