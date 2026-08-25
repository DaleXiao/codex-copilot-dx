export async function initializeModelRegistry({
  loadCached,
  currentModelDefs,
  refresh,
  onBackgroundError = () => {},
}) {
  const cached = loadCached();
  const loaded = cached === true || cached?.loaded === true;
  if (loaded) {
    const backgroundRefresh = cached?.stale === true
      ? runInBackground(refresh, onBackgroundError)
      : null;
    return { modelDefs: currentModelDefs(), source: "cache", backgroundRefresh };
  }

  return { modelDefs: await refresh(), source: "live", backgroundRefresh: null };
}

export function runInBackground(task, onError = () => {}) {
  return Promise.resolve().then(task).catch(onError);
}
