globalThis.fetch = async () => { throw Object.assign(new Error("Offline doctor fixture"), { code: "ECONNREFUSED" }); };
