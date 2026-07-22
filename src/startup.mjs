export async function initializeModelRegistry({
  loadCached,
  currentModelDefs,
  refresh,
}) {
  if (loadCached()) {
    return { modelDefs: currentModelDefs(), source: "cache", backgroundRefresh: null };
  }

  return { modelDefs: await refresh(), source: "live", backgroundRefresh: null };
}

export function runInBackground(task, onError = () => {}) {
  return Promise.resolve().then(task).catch(onError);
}
