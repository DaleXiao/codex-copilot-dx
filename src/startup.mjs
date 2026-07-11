export async function initializeModelRegistry({
  loadCached,
  currentModelDefs,
  refresh,
  onBackgroundError = () => {},
}) {
  if (!loadCached()) {
    return { modelDefs: await refresh(), source: "live", backgroundRefresh: null };
  }

  const backgroundRefresh = Promise.resolve()
    .then(refresh)
    .catch(onBackgroundError);
  return { modelDefs: currentModelDefs(), source: "cache", backgroundRefresh };
}

export function runInBackground(task, onError = () => {}) {
  return Promise.resolve().then(task).catch(onError);
}
