export async function closeHttpServer(server, { timeoutMs = 5000 } = {}) {
  if (!server?.listening) return { forced: false };

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, forced = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve({ forced });
    };

    timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish(null, true);
    }, timeoutMs);
    timer.unref?.();

    try {
      server.close((error) => finish(error));
      server.closeIdleConnections?.();
    } catch (e) {
      if (e?.code === "ERR_SERVER_NOT_RUNNING") finish(null);
      else finish(e);
    }
  });
}
