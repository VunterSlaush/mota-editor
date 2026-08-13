// Linear for Mota Editor — your assigned issues as a sidebar panel.
// Plain Node (18+, for fetch), no dependencies: one JSON object per
// stdin line in, one per stdout line out (MXP, see docs/EXTENSIONS.md).
//
// Setup: put your Linear personal API key (Linear → Settings → API) in
// <dataDir>/config.json as {"apiKey": "lin_api_…"} — the panel tells
// you the exact path until you do. LINEAR_API_KEY in the environment
// works too.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
/** Linear's state.type values, in board order — our group order. */
const STATE_TYPE_ORDER = ["triage", "started", "unstarted", "backlog"];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, message) =>
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
const log = (message) => send({ jsonrpc: "2.0", method: "host/log", params: { message } });

let dataDir = "";
/** issueId → its team's workflow states, cached per process lifetime. */
let statesByTeam = null;

// Exiting the moment `shutdown` arrives would drop replies still being
// built (the host batches stdin) — drain in-flight requests first, with
// a hard stop so a hung fetch cannot outlive the host's kill window.
let inFlight = 0;
let shuttingDown = false;
const maybeExit = () => {
  if (shuttingDown && inFlight === 0) process.exit(0);
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  inFlight += 1;
  handle(msg)
    .catch((e) => {
      if (msg.id !== undefined) replyError(msg.id, String(e && e.message ? e.message : e));
      log(`unhandled: ${e && e.stack ? e.stack : e}`);
    })
    .finally(() => {
      inFlight -= 1;
      maybeExit();
    });
});

async function handle(msg) {
  if (msg.method === "initialize") {
    dataDir = (msg.params && msg.params.dataDir) || "";
    reply(msg.id, { protocolVersion: 1 });
  } else if (msg.method === "panel/load") {
    reply(msg.id, { view: await buildView() });
  } else if (msg.method === "panel/action") {
    reply(msg.id, await handleAction(msg.params));
  } else if (msg.method === "ping") {
    reply(msg.id, {});
  } else if (msg.method === "shutdown") {
    shuttingDown = true;
    setTimeout(() => process.exit(0), 2000).unref();
  } else if (msg.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Unknown method: ${msg.method}` },
    });
  }
}

// ---- The panel ----

async function buildView() {
  const key = apiKey();
  if (!key) return needsKeyView();
  const [issues, states] = await Promise.all([fetchAssignedIssues(key), teamStates(key)]);
  return {
    groups: groupByState(issues, states),
    emptyText: "No open issues assigned to you. Enjoy it while it lasts.",
  };
}

async function handleAction(params) {
  const key = apiKey();
  if (!key) return { view: needsKeyView() };
  const { action, itemId, value } = params || {};
  if (action === "select" && itemId && value) {
    await updateIssueState(key, itemId, value);
    return { view: await buildView() };
  }
  if (action === "open" && itemId) {
    return { detail: await issueDetail(key, itemId) };
  }
  return {};
}

function needsKeyView() {
  const configPath = path.join(dataDir || "<dataDir>", "config.json");
  return {
    groups: [],
    emptyText:
      `Add your Linear API key to use this panel: create ${configPath} ` +
      'containing {"apiKey": "lin_api_…"} (key from Linear → Settings → API → ' +
      "Personal API keys), then hit refresh.",
  };
}

function apiKey() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    return typeof config.apiKey === "string" && config.apiKey.trim()
      ? config.apiKey.trim()
      : null;
  } catch {
    return null;
  }
}

// ---- Linear GraphQL ----

async function linear(key, query, variables) {
  const response = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 401) {
    throw new Error("Linear rejected the API key — check config.json.");
  }
  if (!response.ok) {
    throw new Error(`Linear answered HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(payload.errors[0].message || "Linear returned an error.");
  }
  return payload.data;
}

async function fetchAssignedIssues(key) {
  const data = await linear(
    key,
    `query {
      viewer {
        assignedIssues(
          first: 50
          orderBy: updatedAt
          filter: { state: { type: { nin: ["completed", "canceled"] } } }
        ) {
          nodes {
            id identifier title url priorityLabel
            state { id name type position }
            team { id }
          }
        }
      }
    }`,
  );
  return data.viewer.assignedIssues.nodes;
}

async function teamStates(key) {
  if (statesByTeam) return statesByTeam;
  const data = await linear(
    key,
    `query {
      teams(first: 50) {
        nodes { id states { nodes { id name type position } } }
      }
    }`,
  );
  statesByTeam = new Map(
    data.teams.nodes.map((team) => [
      team.id,
      [...team.states.nodes].sort(
        (a, b) => stateRank(a.type) - stateRank(b.type) || a.position - b.position,
      ),
    ]),
  );
  return statesByTeam;
}

async function updateIssueState(key, issueId, stateId) {
  const data = await linear(
    key,
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issueId, stateId },
  );
  if (!data.issueUpdate.success) throw new Error("Linear refused the status change.");
}

async function issueDetail(key, issueId) {
  const data = await linear(
    key,
    `query($id: String!) {
      issue(id: $id) {
        identifier title description url priorityLabel updatedAt
        state { name }
        project { name }
        labels { nodes { name } }
      }
    }`,
    { id: issueId },
  );
  const issue = data.issue;
  const fields = [
    { label: "Status", value: issue.state.name },
    { label: "Priority", value: issue.priorityLabel },
  ];
  if (issue.project) fields.push({ label: "Project", value: issue.project.name });
  if (issue.labels.nodes.length > 0) {
    fields.push({
      label: "Labels",
      value: issue.labels.nodes.map((label) => label.name).join(", "),
    });
  }
  fields.push({ label: "Updated", value: new Date(issue.updatedAt).toLocaleString() });
  return {
    title: issue.title,
    subtitle: issue.identifier,
    fields,
    body: issue.description || "*No description.*",
    url: issue.url,
  };
}

// ---- Shaping the view model ----

function groupByState(issues, states) {
  // Group by the state NAME (two teams' "In Progress" merge), ordered
  // like a Linear board: active work first, backlog last.
  const groups = new Map();
  const sorted = [...issues].sort(
    (a, b) =>
      stateRank(a.state.type) - stateRank(b.state.type) ||
      a.state.position - b.state.position,
  );
  for (const issue of sorted) {
    const title = issue.state.name;
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(issue);
  }
  return [...groups.entries()].map(([title, members]) => ({
    title,
    items: members.map((issue) => ({
      id: issue.id,
      title: issue.title,
      subtitle: issue.identifier,
      badge: issue.priorityLabel === "No priority" ? undefined : issue.priorityLabel,
      select: {
        options: (states.get(issue.team.id) || []).map((s) => ({
          id: s.id,
          label: s.name,
        })),
        selectedId: issue.state.id,
      },
    })),
  }));
}

function stateRank(type) {
  const rank = STATE_TYPE_ORDER.indexOf(type);
  return rank === -1 ? STATE_TYPE_ORDER.length : rank;
}
