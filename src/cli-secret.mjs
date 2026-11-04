import readline from "node:readline";

export function hiddenQuestion(input, output, question, { cancelMessage = "API setup cancelled" } = {}) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Hidden API key input requires an interactive terminal"));
  }
  output.write(question);
  const wasRaw = Boolean(input.isRaw);
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
      output.write("\n");
    };
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error(cancelMessage));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(value);
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && typeof text === "string" && text >= " " && text !== "\x7f") value += text;
    };
    input.on("keypress", onKeypress);
  });
}
