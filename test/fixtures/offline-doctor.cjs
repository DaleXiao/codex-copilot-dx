const { EventEmitter } = require("node:events");
globalThis.fetch = async () => { throw Object.assign(new Error("Offline doctor fixture"), { code: "ECONNREFUSED" }); };
require("node:net").createConnection = () => {
  const socket = new EventEmitter();socket.setTimeout = () => socket;socket.destroy = () => socket;
  setImmediate(() => socket.emit("error", Object.assign(new Error("Offline doctor fixture"), { code: "ECONNREFUSED" })));
  return socket;
};
require("node:module").syncBuiltinESMExports();
