// The whole Mota Extension Protocol, in plain Node: read one JSON object
// per stdin line, write one per stdout line. No SDK, no dependencies.
// Docs: docs/EXTENSIONS.md in the Mota repository.
const readline = require("node:readline");

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const log = (message) => send({ jsonrpc: "2.0", method: "host/log", params: { message } });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    reply(msg.id, { protocolVersion: 1 });
    log("standup extension initialized");
  } else if (msg.method === "command/execute") {
    const { command, context } = msg.params;
    if (command === "standup-notify") {
      reply(msg.id, {
        actions: [
          {
            type: "insertPrompt",
            text: "Summarize today's work in this repository as a standup update.",
          },
          {
            type: "notify",
            title: "Standup",
            message: `Draft prompt ready in ${context.projectPath}. Press Enter to run it.`,
          },
        ],
      });
    } else {
      reply(msg.id, { actions: [] });
    }
  } else if (msg.method === "shutdown") {
    process.exit(0);
  } else if (msg.id !== undefined) {
    // A request this extension does not know — politely decline.
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Unknown method: ${msg.method}` },
    });
  }
});
