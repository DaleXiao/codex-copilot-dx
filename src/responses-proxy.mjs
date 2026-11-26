import { markToolActivity } from "./stream-performance.mjs";
import { sourceResponseReader, cancelSourceReader, releaseSourceReader } from "./source-response.mjs";
import { responses as copilotResponses } from "./copilot.mjs";
import {
  logRequestFailure,
  MAX_UPSTREAM_ERROR_BODY_BYTES,
  MAX_UPSTREAM_RESPONSES_SUCCESS_BODY_BYTES,
  readBoundedResponseText,
  sendUpstreamError,
  writeOrDrain,
} from "./http-transport.mjs";
import { httpError } from "./http-errors.mjs";
import {
  hasCopilotResponseRetryPolicy,
  openCopilotResponse,
  selectCopilotResponseRetryWithHistory,
} from "./copilot-responses-compat.mjs";
import {
  dropMaterializedResponseHistory,
  hasEncryptedResponseState,
  rememberResponseHistory,
  restoreMaterializedResponseHistoryForRetry,
} from "./responses-request.mjs";
import {
  formatResponseFailureLog,
  responseFailureDetails,
  responseFailureText,
} from "./response-failures.mjs";
import {
  compactionInputWithoutTrigger,
  parseResponsesCompactionResult,
} from "./responses-compaction.mjs";
import { createResponseSseTransformer } from "./responses-sse.mjs";
import { endStreamWithError } from "./stream-errors.mjs";
import { createSseKeepalive } from "./sse-keepalive.mjs";
import {
  incompleteUpstreamStream,
  requireUpstreamEventStream,
  ToolArgumentDeltaGuard,
} from "./stream-contract.mjs";
import {
  markResponseErrorOrigin,
  markResponseTerminal,
  markStreamFailure,
  markUpstreamActivity,
} from "./stream-performance.mjs";
import { safeUpstreamResponseHeaders } from "./upstream-headers.mjs";
import { recordResponsesUsage } from "./usage-store.mjs";
import { COMPACTION_USAGE_RECORDED } from "./context-compaction.mjs";
import { status } from "./status.mjs";

const SSE_WRITE_BATCH_BYTES = 64 * 1024;
const STREAM_RETRY_PRELUDE_MAX_BYTES = 256 * 1024;
function invalidResponsesResponse(message) {
  const error = httpError(message, 502);
  error.code = "ccdx_invalid_responses_response";
  error.jsonBody = {
    error: {
      message,
      type: "upstream_error",
      code: error.code,
    },
  };
  return error;
}

function parseSuccessfulResponsesResult(text) {
  let response;
  try {
    response = JSON.parse(text);
  } catch {
    throw invalidResponsesResponse("Copilot Responses returned invalid JSON");
  }
  if (!response
    || typeof response !== "object"
    || Array.isArray(response)
    || typeof response.id !== "string"
    || response.id.length === 0
    || !Array.isArray(response.output)) {
    throw invalidResponsesResponse("Copilot Responses returned an invalid response envelope");
  }
  return response;
}

function storeCompletedResponse(reqContext, completed) {
  if (!completed) return;
  rememberResponseHistory(reqContext, reqContext.privacyRestore?.(completed.response) || completed.response);
  if (!reqContext.compactionUsageRecorded) recordResponsesUsage({
    surface: reqContext.surface,
    mode: "stream",
    model: reqContext.body?.model,
    response: completed.response,
    event: completed.event,
  });
}

function streamHeaders(resp) {
  return {
    ...safeUpstreamResponseHeaders(resp.headers, { defaultContentType: "text/event-stream", allowReasoningIncluded: resp.ok }),
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
}

async function selectStreamFailureRetry(reqContext, failure, usedRetryPolicies, options) {
  if (!failure) return null;
  const errorText = responseFailureText(failure.event, failure.eventType);
  if (!(options.compatibility?.hasRetry || hasCopilotResponseRetryPolicy)(400, errorText, usedRetryPolicies)) return null;
  const preparation = await options.acquireRetryPreparation?.(reqContext);
  let keepReservation = false;
  try {
    const restored = restoreMaterializedResponseHistoryForRetry(reqContext, {
      assertActive: options.assertPrepareActive,
      historySnapshot: preparation?.historySnapshot,
    });
    const retry = await (options.compatibility?.selectRetry || selectCopilotResponseRetryWithHistory)(restored, 400, errorText, usedRetryPolicies, {
      ...options, reserveHistory: preparation?.reserveHistory || options.reserveHistory,
    });
    options.assertPrepareActive?.();
    keepReservation = Boolean(retry);
    return {
      retry: retry ? { ...retry, releasePreparation: () => { retry.releasePreparation?.();preparation?.release(); } } : null,
      retrySkipped: null,
    };
  } catch (error) {
    options.assertPrepareActive?.();
    if (error.code === "ccdx_history_rebuild_required") throw error;
    return { retry: null, retrySkipped: "history_unavailable" };
  } finally {
    if (!keepReservation) preparation?.release();
  }
}

function recordResponseFailure(options, reqContext, resp, failure, {
  retry,
  retrySkipped,
  recovery,
} = {}) {
  if (!failure) return;
  const details = responseFailureDetails(failure.event, failure.eventType, {
    model: reqContext.body?.model,
    headers: resp.headers,
    retried: Boolean(retry),
    retryPolicy: retry?.policyId,
    retrySkipped,
  });
  if (retry?.recovery) details.recovery = retry.recovery;
  else if (recovery) details.recovery = recovery;
  options.responseFailures?.record?.(details);
  console.warn(status("warn", formatResponseFailureLog(details)));
}

async function proxyStreamingResponses(opened, res, upstream, options) {
  while (true) {
    let {
      resp,
      errorText,
      reqContext,
      streamRetryEligible = false,
      usedRetryPolicies = new Set(),
    } = opened;
    if (errorText !== undefined) {
      markResponseErrorOrigin("upstream_http");
      sendUpstreamError(res, resp, errorText);
      return { successful: false, compacted: false, upstreamStatus: resp.status };
    }
    await requireUpstreamEventStream(resp);
    options.onStreamStart?.();
    options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
    const headers = streamHeaders(resp);
    let headersSent = false;
    const writeHeaders = () => {
      if (headersSent || res.headersSent) return;
      headersSent = true;
      res.writeHead(resp.status, headers);
    };
    const reader = sourceResponseReader(resp);
    const streamState = {
      sourceResponse: resp,
      completed: null,
      incomplete: null,
      failure: null,
      sawTerminal: false,
      sawOutput: false,
      response: {},
      model: reqContext.body?.model,
      lastSequence: -1,
      toolArgumentGuard: new ToolArgumentDeltaGuard(),
      messageIds: new Map(),
      protectCompactionResult: reqContext.protectCompactionResult,
    };
    const transformer = createResponseSseTransformer(streamState);
    let holdPrelude = streamRetryEligible;
    let retryDisabledReason = holdPrelude ? null : "request_not_eligible";
    const prelude = [];
    let preludeBytes = 0;
    const keepalive = createSseKeepalive({ res, signal: options.signal,
      intervalMs: options.keepaliveIntervalMs,
      canWrite: () => !holdPrelude && !streamState.sawTerminal });
    const flushPrelude = async () => {
      if (!preludeBytes) return true;
      writeHeaders();
      const body = prelude.length === 1 ? prelude[0] : Buffer.concat(prelude, preludeBytes);
      prelude.length = 0;
      preludeBytes = 0;
      keepalive.activity();
      return writeOrDrain(res, body, { signal: options.signal });
    };
    const forwardFrame = async (frame) => {
      if (!frame) return true;
      if (!holdPrelude) {
        writeHeaders();
        keepalive.activity();
        return writeOrDrain(res, frame, { signal: options.signal });
      }
      prelude.push(frame);
      preludeBytes += frame.byteLength;
      if (!streamState.sawOutput && preludeBytes <= STREAM_RETRY_PRELUDE_MAX_BYTES) return true;
      retryDisabledReason = streamState.sawOutput ? "output_started" : "prelude_limit";
      holdPrelude = false;
      return flushPrelude();
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (!await forwardFrame(transformer.finish())) return { successful: false, compacted: false };
          if (!streamState.sawTerminal) throw incompleteUpstreamStream("a terminal Responses event");
          break;
        }
        markUpstreamActivity();
        options.abort?.setTimeout(options.streamIdleTimeoutMs, "stream_idle_timeout");
        for (let offset = 0; offset < value.byteLength; offset += SSE_WRITE_BATCH_BYTES) {
          const frame = transformer.push(value.subarray(offset, offset + SSE_WRITE_BATCH_BYTES));
          if (!await forwardFrame(frame)) return { successful: false, compacted: false };
          if (streamState.sawTerminal) break;
        }
        if (streamState.sawTerminal) break;
      }

      let retry = null;
      if (streamState.failure && holdPrelude && !streamState.sawOutput) {
        let selected;
        try {
          selected = await selectStreamFailureRetry(reqContext, streamState.failure, usedRetryPolicies, options);
        } catch (error) {
          recordResponseFailure(options, reqContext, resp, streamState.failure, {
            retrySkipped: error.code === "ccdx_history_rebuild_required" ? error.code : "retry_preparation_failed",
            recovery: error.jsonBody?.error?.recovery,
          });
          throw error;
        }
        retry = selected?.retry || null;
        if (!retry) retryDisabledReason = selected?.retrySkipped || "not_applicable";
      }
      if (streamState.failure) {
        recordResponseFailure(options, reqContext, resp, streamState.failure, {
          retry,
          retrySkipped: retry ? null : retryDisabledReason,
        });
      }
      if (retry) {
        console.warn(status("warn", retry.warning));
        try {
          opened = await (options.compatibility?.openResponse || openCopilotResponse)(retry.reqContext, upstream, {
            ...options,
            usedRetryPolicies: retry.usedPolicies,
          });
          opened.streamRetryEligible = hasEncryptedResponseState(opened.reqContext.body?.input);
          dropMaterializedResponseHistory(opened.reqContext);
        } finally {
          retry.releasePreparation?.();
        }
        continue;
      }
      if (holdPrelude && !await flushPrelude()) return { successful: false, compacted: false };
      if (streamState.completed) {
        markResponseTerminal("completed", {
          model: streamState.completed.response.model || reqContext.body?.model,
          origin: "upstream_response",
        });
      } else if (streamState.incomplete) {
        markResponseTerminal("incomplete", {
          model: streamState.incomplete.response.model || reqContext.body?.model,
          origin: "upstream_response",
          reason: streamState.incomplete.response.incomplete_details?.reason,
        });
      } else if (streamState.failure) {
        markStreamFailure();
        markResponseTerminal("failed", { model: reqContext.body?.model, origin: "upstream_event" });
      }
      storeCompletedResponse(reqContext, streamState.completed);
      if (!res.writableEnded) res.end();
      return { successful: Boolean(streamState.completed), compacted: false };
    } catch (error) {
      markResponseErrorOrigin(["privacy", "source_admission"].includes(error.origin) ? error.origin : "transport");
      markStreamFailure();
      logRequestFailure("Responses", error, options.abort);
      writeHeaders();
      await endStreamWithError(res, error, options.abort, {
        response: streamState.response, model: streamState.model, sequenceNumber: streamState.lastSequence + 1,
      });
      return { successful: false, compacted: false };
    } finally {
      keepalive.stop();
      await cancelSourceReader(reader).catch(() => {});
      releaseSourceReader(reader);
    }
  }
}

export async function proxyCopilotResponses(reqContext, req, res, upstream = copilotResponses, options = {}) {
  let opened;
  try {
    opened = await (options.compatibility?.openResponse || openCopilotResponse)(reqContext, upstream, options);
    opened.streamRetryEligible = opened.reqContext.body.stream === true
      && hasEncryptedResponseState(opened.reqContext.body?.input);
  } finally {
    options.releaseRequest?.(opened?.reqContext);
  }
  reqContext = opened.reqContext;
  if (reqContext.body.stream) {
    return proxyStreamingResponses(opened, res, upstream, options);
  }

  while (true) {
    const { resp, errorText, usedRetryPolicies = new Set() } = opened;
    reqContext = opened.reqContext;
    if (errorText !== undefined) {
      markResponseErrorOrigin("upstream_http");
      sendUpstreamError(res, resp, errorText);
      return { successful: false, compacted: false, upstreamStatus: resp.status };
    }
    const data = resp.ok
      ? await readBoundedResponseText(resp, {
        maxBytes: MAX_UPSTREAM_RESPONSES_SUCCESS_BODY_BYTES,
        label: "Copilot Responses success body",
        signal: options.signal,
      })
      : await readBoundedResponseText(resp, {
        maxBytes: MAX_UPSTREAM_ERROR_BODY_BYTES,
        label: "Copilot Responses error body",
      });
    if (resp.ok && reqContext.surface === "responses_compact") {
      let response = parseResponsesCompactionResult(
        compactionInputWithoutTrigger(reqContext.body.input),
        data,
      );
      response = reqContext.protectCompactionResult?.(response) || response;
      markToolActivity(response);
      rememberResponseHistory(reqContext, reqContext.privacyRestore?.(response) || response);
      if (!resp[COMPACTION_USAGE_RECORDED]) recordResponsesUsage({
        surface: reqContext.surface,
        mode: "json",
        model: reqContext.body?.model,
        response,
        event: response,
      });
      markResponseTerminal("completed", { model: response.model || reqContext.body?.model, origin: "upstream_response" });
      res.writeHead(resp.status, safeUpstreamResponseHeaders(resp.headers, {
        contentType: "application/json",
        allowReasoningIncluded: true,
      }));
      res.end(JSON.stringify(response));
      return { successful: true, compacted: true };
    }
    if (resp.ok) {
      const response = parseSuccessfulResponsesResult(data);
      if (response.status === "failed") {
        const failure = { event: { type: "response.failed", response }, eventType: "response.failed" };
        let selected;
        try {
          selected = await selectStreamFailureRetry(reqContext, failure, usedRetryPolicies, options);
        } catch (error) {
          recordResponseFailure(options, reqContext, resp, failure, {
            retrySkipped: error.code === "ccdx_history_rebuild_required" ? error.code : "retry_preparation_failed",
            recovery: error.jsonBody?.error?.recovery,
          });
          throw error;
        }
        const retry = selected?.retry || null;
        recordResponseFailure(options, reqContext, resp, failure, {
          retry,
          retrySkipped: retry ? null : selected?.retrySkipped || "not_applicable",
        });
        if (retry) {
          console.warn(status("warn", retry.warning));
          try {
            opened = await (options.compatibility?.openResponse || openCopilotResponse)(retry.reqContext, upstream, {
              ...options,
              usedRetryPolicies: retry.usedPolicies,
            });
            dropMaterializedResponseHistory(opened.reqContext);
          } finally {
            retry.releasePreparation?.();
          }
          continue;
        }
      }
      markToolActivity(response);
      rememberResponseHistory(reqContext, reqContext.privacyRestore?.(response) || response);
      if (!reqContext.compactionUsageRecorded) recordResponsesUsage({
        surface: reqContext.surface,
        mode: "json",
        model: reqContext.body?.model,
        response,
        event: response,
      });
      if (["completed", "incomplete", "failed"].includes(response.status)) {
        markResponseTerminal(response.status, {
          model: response.model || reqContext.body?.model,
          origin: "upstream_response",
          reason: response.incomplete_details?.reason,
        });
      }
      res.writeHead(resp.status, safeUpstreamResponseHeaders(resp.headers, {
        contentType: "application/json",
        allowReasoningIncluded: response.status !== "failed",
      }));
      res.end(data);
      return { successful: response.status !== "failed" && response.status !== "incomplete", compacted: false };
    }
    res.writeHead(resp.status, safeUpstreamResponseHeaders(resp.headers, {
      contentType: "application/json",
    }));
    markResponseErrorOrigin("upstream_http");
    res.end(data);
    return { successful: false, compacted: false };
  }
}
