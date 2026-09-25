// Jev for Mota Editor — TypeSafe AI's "System One" classifier as a tool
// your agents can call. Plain Node (18+, for fetch), no dependencies.
//
// One file, two roles:
//   node main.cjs          the extension process (MXP, docs/EXTENSIONS.md):
//                          a sidebar panel to save, test and forget the key.
//   node main.cjs --mcp    the MCP server the agent CLI spawns: one tool,
//                          `jev_ask`, over newline-delimited JSON-RPC.
//
// The MCP process never hears the host's dataDir, so the key lives beside
// this file in config.json ({"apiKey": "..."}, owner-only where the OS has
// such a thing). TYPESAFE_API_KEY in the environment wins over it. Both
// are read again on every call, so saving a key needs no restart.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const TOOL_TIMEOUT_MS = 60_000;
/** Inside the host's 30 s panel-action budget. */
const TEST_TIMEOUT_MS = 20_000;
const MAX_QUESTIONS = 16;
const QUESTION_TYPES = ["noul", "choice", "score"];
const CONFIG_PATH = path.join(__dirname, "config.json");
const VERSION = "0.1.0";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

const mcpMode = process.argv.includes("--mcp");

// ---- Shared: the key and the one HTTP call ----

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; tighten one that existed.
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {}
}

/** The key to use and where it came from, or null when there is none. */
function resolveKey() {
  const fromEnv = (process.env.TYPESAFE_API_KEY || "").trim();
  if (fromEnv) return { key: fromEnv, source: "TYPESAFE_API_KEY" };
  const saved = readConfig().apiKey;
  if (typeof saved === "string" && saved.trim()) {
    return { key: saved.trim(), source: "config.json" };
  }
  return null;
}

/** POST one request to Jev; resolves to the parsed body or throws a
 *  message a person can act on. */
async function callJev(key, body, timeoutMs) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (response.status === 401) {
    throw new Error("Jev rejected the key (401) — check it in the Jev panel or TYPESAFE_API_KEY.");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// ---- MCP mode ----

const INSTRUCTIONS =
  "jev_ask sends a state (text, an object or an array) and up to 16 typed questions to Jev, a fast calibrated classifier, and returns a probability or pick per question in well under a second. " +
  "Use it for judgments you want calibrated and cheap — is this command risky, which category fits, how severe is this — rather than for generating text.";

const TOOL = {
  name: "jev_ask",
  title: "Ask Jev",
  description:
    "Ask Jev, TypeSafe AI's classifier, typed questions about a state. It does not write text; it answers every question in one parallel pass with calibrated probabilities.\n\n" +
    "Question types: `noul` (yes/no → probability of yes), `choice` (pick one of `criteria`, an object of option → description), `score` (a level from `criteria`, an array of level descriptions, lowest first).\n\n" +
    "Example — judging a shell command before running it:\n" +
    '{"state": {"command": "rm -rf ./build", "cwd": "/repo", "task": "clean the build"},\n' +
    ' "questions": {\n' +
    '   "destructive": {"type": "noul", "instructions": "Would running command delete data that is not trivially recoverable?"},\n' +
    '   "scope": {"type": "choice", "instructions": "Where does command act?", "criteria": {"project": "only inside cwd", "outside": "outside cwd"}},\n' +
    '   "severity": {"type": "score", "instructions": "How bad is the worst case?", "criteria": ["harmless", "annoying", "costly", "catastrophic"]}}}\n' +
    'Answers look like {"destructive": {"type": "noul", "noul": 0.12}, "scope": {"type": "choice", "choice": "project", "probabilities": {...}, "confidence": 0.9}, ...}.',
  inputSchema: {
    type: "object",
    properties: {
      // Left untyped on purpose: it may be a string, an object or an
      // array, and Gemini's schema converter rejects `anyOf`. The handler
      // checks it.
      state: {
        description: "What Jev judges: a string, a JSON object, or an array.",
      },
      questions: {
        type: "object",
        description:
          "Question key → {type: 'noul'|'choice'|'score', instructions: string, criteria?}. 1 to 16 questions; name the fields of `state` in the instructions.",
      },
      model: { type: "string", description: `Jev model id. Defaults to ${DEFAULT_MODEL}.` },
    },
    required: ["state", "questions"],
  },
};

function runMcp() {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    handleMcp(msg).catch((e) => {
      console.error(`jev: ${e && e.stack ? e.stack : e}`);
      if (msg.id !== undefined) replyError(msg.id, -32603, String(e && e.message ? e.message : e));
    });
  });
}

async function handleMcp(msg) {
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "jev", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, { tools: [TOOL] });
    case "tools/call":
      return handleToolCall(msg);
    default:
      if (msg.id !== undefined) replyError(msg.id, -32601, `Unknown method: ${msg.method}`);
      return undefined;
  }
}

async function handleToolCall(msg) {
  const params = msg.params || {};
  if (params.name !== TOOL.name) {
    return replyError(msg.id, -32602, `Unknown tool: ${params.name}`);
  }
  const args = params.arguments || {};
  const problem = argumentProblem(args);
  if (problem) return reply(msg.id, toolError(problem));

  const resolved = resolveKey();
  if (!resolved) {
    return reply(
      msg.id,
      toolError("No Jev key. Save one in Mota's Jev panel, or set TYPESAFE_API_KEY."),
    );
  }
  try {
    const body = await callJev(
      resolved.key,
      { model: args.model || DEFAULT_MODEL, state: args.state, questions: args.questions },
      TOOL_TIMEOUT_MS,
    );
    if (!body || typeof body.answers !== "object") {
      return reply(msg.id, toolError("Jev's reply carried no answers."));
    }
    return reply(msg.id, {
      content: [{ type: "text", text: JSON.stringify(body.answers, null, 2) }],
      structuredContent: { answers: body.answers, usage: body.usage },
    });
  } catch (e) {
    return reply(msg.id, toolError(`Jev call failed: ${e && e.message ? e.message : e}`));
  }
}

/** Why these arguments cannot be sent, or null. Validated here because
 *  the schema is deliberately loose (see `state` above). */
function argumentProblem(args) {
  const { state, questions, model } = args;
  const stateOk =
    typeof state === "string" || (typeof state === "object" && state !== null);
  if (!stateOk) return "`state` must be a string, an object or an array.";
  if (typeof questions !== "object" || questions === null || Array.isArray(questions)) {
    return "`questions` must be an object of question key → question.";
  }
  const entries = Object.entries(questions);
  if (entries.length === 0 || entries.length > MAX_QUESTIONS) {
    return `Ask between 1 and ${MAX_QUESTIONS} questions.`;
  }
  for (const [key, question] of entries) {
    if (!question || !QUESTION_TYPES.includes(question.type)) {
      return `Question \`${key}\` needs type noul, choice or score.`;
    }
    if (typeof question.instructions !== "string" || !question.instructions.trim()) {
      return `Question \`${key}\` needs instructions.`;
    }
    if (question.type === "choice" && !isPlainObject(question.criteria)) {
      return `Choice question \`${key}\` needs criteria: an object of option → description.`;
    }
    if (question.type === "score" && !Array.isArray(question.criteria)) {
      return `Score question \`${key}\` needs criteria: an array of levels, lowest first.`;
    }
  }
  if (model !== undefined && typeof model !== "string") return "`model` must be a string.";
  return null;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// ---- Extension mode: the panel ----

/** What the last Test said, shown until the next one. */
let lastTest = null;

// Exiting the moment `shutdown` arrives would drop replies still being
// built — drain in-flight requests first, with a hard stop.
let inFlight = 0;
let shuttingDown = false;
const maybeExit = () => {
  if (shuttingDown && inFlight === 0) process.exit(0);
};

function runExtension() {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    inFlight += 1;
    handleExtension(msg)
      .catch((e) => {
        if (msg.id !== undefined) replyError(msg.id, -32000, String(e && e.message ? e.message : e));
      })
      .finally(() => {
        inFlight -= 1;
        maybeExit();
      });
  });
}

async function handleExtension(msg) {
  if (msg.method === "initialize") {
    reply(msg.id, { protocolVersion: 1 });
  } else if (msg.method === "panel/load") {
    reply(msg.id, { view: panelView() });
  } else if (msg.method === "panel/action") {
    reply(msg.id, await panelAction(msg.params || {}));
  } else if (msg.method === "ping") {
    reply(msg.id, {});
  } else if (msg.method === "shutdown") {
    shuttingDown = true;
    setTimeout(() => process.exit(0), 2000).unref();
  } else if (msg.id !== undefined) {
    replyError(msg.id, -32601, `Unknown method: ${msg.method}`);
  }
}

async function panelAction({ action, itemId, value }) {
  if (action === "submit" && itemId === "key") {
    const key = String(value || "").trim();
    if (key) {
      saveConfig({ apiKey: key });
      lastTest = null;
    }
  } else if (action === "button" && itemId === "test") {
    lastTest = await testKey();
  } else if (action === "button" && itemId === "forget") {
    saveConfig({ apiKey: undefined });
    lastTest = null;
  }
  return { view: panelView() };
}

/** One cheap yes/no call, to prove the key and the network both work. */
async function testKey() {
  const resolved = resolveKey();
  if (!resolved) return { ok: false, text: "No key to test." };
  const started = Date.now();
  try {
    const body = await callJev(
      resolved.key,
      {
        model: DEFAULT_MODEL,
        state: "Hello from Mota Editor.",
        questions: { greeting: { type: "noul", instructions: "Is this text a greeting?" } },
      },
      TEST_TIMEOUT_MS,
    );
    return { ok: true, text: `Answered in ${Date.now() - started} ms (${body.model || "jev"}).` };
  } catch (e) {
    return { ok: false, text: String(e && e.message ? e.message : e) };
  }
}

function panelView() {
  const resolved = resolveKey();
  const items = [
    {
      id: "key",
      title: resolved ? "Key configured" : "No key yet",
      subtitle: resolved
        ? `From ${resolved.source}.`
        : "Paste your TypeSafe key below and press Enter, or set TYPESAFE_API_KEY.",
      badge: resolved ? "Ready" : "Missing",
      badgeTone: resolved ? "success" : "warning",
    },
  ];
  if (lastTest) {
    items.push({
      id: "test",
      title: lastTest.ok ? "Test passed" : "Test failed",
      subtitle: lastTest.text,
      badge: lastTest.ok ? "OK" : "Error",
      badgeTone: lastTest.ok ? "success" : "danger",
    });
  }
  const buttons = resolved ? [{ id: "test", label: "Test" }] : [];
  if (readConfig().apiKey) buttons.push({ id: "forget", label: "Forget key" });
  return {
    groups: [{ title: "Jev", items }],
    buttons,
    input: { id: "key", placeholder: "Paste a TypeSafe API key…" },
    emptyText: "Jev is available to your agents as the jev_ask tool in new chats.",
  };
}

if (mcpMode) runMcp();
else runExtension();
