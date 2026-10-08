import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createAdapterHandler } from "../src/adapter.mjs";

function jsonRequest(body, contentEncoding, headers = {}) {
  const req = Readable.from([body]);
  req.headers = { ...headers };
  if (contentEncoding) req.headers["content-encoding"] = contentEncoding;
  return req;
}

export async function invokeAdapterRequest(options, req) {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headersSent = false;
  res.statusCode = 200;
  res.headers = {};
  const chunks = [];
  res.writeHead = (statusCode, headers = {}) => {
    res.statusCode = statusCode;
    res.headers = { ...res.headers, ...headers };
    res.headersSent = true;
    return res;
  };
  res.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    return true;
  };
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    res.writableEnded = true;
    res.writableFinished = true;
    res.emit("finish");
    finish();
    return res;
  };

  const handler = createAdapterHandler(options);
  try {
    const pending = handler(req, res);
    await Promise.all([pending, finished]);
    return {
      status: res.statusCode,
      headers: res.headers,
      text: Buffer.concat(chunks).toString("utf8"),
    };
  } finally {
    handler.cleanup?.();
  }
}

export async function invokeAdapter(options, { method = "POST", url = "/v1/responses", body, headers = {} } = {}) {
  const req = jsonRequest(Buffer.from(JSON.stringify(body ?? {})), undefined, { "content-type": "application/json", ...headers });
  req.method = method;
  req.url = url;
  req.socket = { remoteAddress: "127.0.0.1" };
  return invokeAdapterRequest(options, req);
}
