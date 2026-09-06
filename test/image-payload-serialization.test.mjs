import test from "node:test";
import assert from "node:assert/strict";
import { prepareResponsesPayload } from "../src/image-optimization.mjs";

for (const stringified of [false, true]) {
  for (const changes of [false, true]) {
    test(`image payload reuses exact serialization after a ${changes ? "successful" : "no-op"} profile (${stringified ? "tool JSON" : "message"})`, async () => {
      const original = `data:image/png;base64,${Buffer.alloc(9000, 65).toString("base64")}`;
      const reduced = `data:image/webp;base64,${Buffer.alloc(300, 66).toString("base64")}`;
      const parts = [
        { type: "input_text", text: '保留引号 " 和换行\n' },
        { type: "input_image", image_url: original, detail: "high" },
      ];
      const body = {
        model: "gpt-5.6-sol",
        input: [stringified
          ? { type: "function_call_output", call_id: "call_image", output: JSON.stringify(parts) }
          : { type: "message", role: "user", content: parts }],
      };
      const stringify = JSON.stringify;
      const warn = console.warn;
      let serializations = 0;
      const qualities = [];
      JSON.stringify = function (value, ...args) {
        if (value === body) serializations += 1;
        return stringify(value, ...args);
      };
      console.warn = () => {};
      let result;
      try {
        result = await prepareResponsesPayload(body, {
          maxBytes: 2000,
          profiles: [{ maxDim: 1600, quality: 75 }],
          optimizeImage: async (value, { quality }) => {
            qualities.push(quality);
            assert.equal(value, original);
            return changes && quality === 75 ? reduced : value;
          },
        });
      } finally {
        JSON.stringify = stringify;
        console.warn = warn;
      }
      assert.equal(serializations, changes ? 2 : 1);
      assert.deepEqual(qualities, [82, 75]);
      assert.equal(result.bodyText, JSON.stringify(body));
      assert.equal(result.bodyBytes, Buffer.byteLength(result.bodyText));
      assert.equal(result.overBudget, !changes);
      assert.equal(result.adapted, changes);
      const outputParts = stringified ? JSON.parse(body.input[0].output) : body.input[0].content;
      assert.deepEqual(outputParts, [parts[0], { type: "input_image", image_url: changes ? reduced : original, detail: "high" }]);
    });
  }
}
