// Linear for Mota Editor — your assigned issues as a sidebar panel.
// Plain Node (18+, for fetch), no dependencies: one JSON object per
// stdin line in, one per stdout line out (MXP, see docs/EXTENSIONS.md).
//
// Signing in — the "Log in with Linear" button runs real OAuth (PKCE,
// no client secret needed): browser opens Linear's own login/consent
// screen, tokens land in <dataDir>/config.json, and they refresh
// themselves. Linear has no anonymous OAuth, so the very first run
// serves a one-time setup page: create an OAuth app in your workspace
// (link provided, callback URL spelled out), paste its Client ID, and
// the same browser tab continues straight into the login. After that
// it is one click forever. Personal API keys still work as a fallback
// ({"apiKey": …} in config.json, or LINEAR_API_KEY in the environment).
// The panel refreshes itself when the browser round-trip lands
// (`panels/refresh`).
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
const LINEAR_OAUTH_AUTHORIZE = "https://linear.app/oauth/authorize";
const LINEAR_OAUTH_TOKEN = "https://api.linear.app/oauth/token";
const LINEAR_NEW_APP_PAGE = "https://linear.app/settings/api/applications/new";
const LINEAR_KEYS_PAGE = "https://linear.app/settings/api";
// Linear requires the registered callback URL to match exactly, so the
// OAuth listener uses a fixed port; the setup page spells it out.
const OAUTH_PORT = 52560;
const OAUTH_REDIRECT = `http://localhost:${OAUTH_PORT}/callback`;
const OAUTH_SCOPE = "read,write";
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
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
/** The one login attempt in flight, or null. */
let login = null;
let outgoingId = 1;

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
    endLogin("shutdown");
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
  const auth = await freshAuthHeader();
  if (!auth) return signInView();
  try {
    const [issues, states] = await Promise.all([
      fetchAssignedIssues(auth),
      teamStates(auth),
    ]);
    return {
      groups: groupByState(issues, states),
      emptyText: "No open issues assigned to you. Enjoy it while it lasts.",
    };
  } catch (e) {
    if (e && e.unauthorized) {
      return signInView("Your Linear session expired — log in again.");
    }
    throw e;
  }
}

async function handleAction(params) {
  const { action, itemId, value } = params || {};
  if (action === "button" && itemId === "login") return startLogin();
  const auth = await freshAuthHeader();
  if (!auth) return { view: signInView() };
  if (action === "select" && itemId && value) {
    await updateIssueState(auth, itemId, value);
    return { view: await buildView() };
  }
  if (action === "open" && itemId) {
    return { detail: await issueDetail(auth, itemId) };
  }
  return {};
}

function signInView(reason) {
  return {
    groups: [],
    buttons: [{ id: "login", label: "Log in with Linear" }],
    emptyText:
      (reason ? `${reason} ` : "") +
      "Sign in with your browser to see your issues.",
  };
}

function waitingView() {
  return {
    groups: [],
    buttons: [{ id: "login", label: "Restart browser login" }],
    emptyText:
      "Finish signing in inside your browser — this panel refreshes by itself when you are done.",
  };
}

// ---- Auth ----

function configPath() {
  return path.join(dataDir || "<dataDir>", "config.json");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`);
}

/** The Authorization header value, refreshed when the OAuth token is
 *  near expiry; null when signed out. Personal API keys go raw; OAuth
 *  access tokens go as Bearer. */
async function freshAuthHeader() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  let config = readConfig();
  const nearExpiry =
    typeof config.expiresAt === "number" && Date.now() > config.expiresAt - 60_000;
  if (config.accessToken && config.refreshToken && nearExpiry) {
    await refreshTokens().catch((e) => log(`token refresh failed: ${e}`));
    config = readConfig();
  }
  if (typeof config.accessToken === "string" && config.accessToken.trim()) {
    return `Bearer ${config.accessToken.trim()}`;
  }
  if (typeof config.apiKey === "string" && config.apiKey.trim()) {
    return config.apiKey.trim();
  }
  return null;
}

function oauthClientId() {
  const oauth = readConfig().oauth;
  return oauth && typeof oauth.clientId === "string" && oauth.clientId.trim()
    ? oauth.clientId.trim()
    : null;
}

async function refreshTokens() {
  const config = readConfig();
  const clientId = oauthClientId();
  if (!config.refreshToken || !clientId) throw new Error("nothing to refresh with");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.refreshToken,
    client_id: clientId,
  });
  const oauth = config.oauth || {};
  if (oauth.clientSecret) body.set("client_secret", oauth.clientSecret);
  const response = await fetch(LINEAR_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  saveTokens(await response.json());
}

function saveTokens(payload) {
  if (!payload.access_token) throw new Error("Linear sent no access token.");
  saveConfig({
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || readConfig().refreshToken,
    expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined,
    // A stored personal key would otherwise shadow-fight the token.
    apiKey: undefined,
  });
}

// ---- Browser login ----

function startLogin() {
  endLogin("restarted");
  void runLoginFlow().catch((e) => {
    log(`login failed: ${e && e.stack ? e.stack : e}`);
    endLogin("failed");
  });
  // Reply inside the 30 s action budget; the browser round-trip finishes
  // on its own time and announces itself with panels/refresh.
  return { view: waitingView() };
}

async function runLoginFlow() {
  const clientId = oauthClientId();
  if (clientId) {
    const url = await startOauthListener(clientId);
    openBrowser(url);
  } else {
    await startSetupListener();
  }
}

/** Bind the fixed-port callback listener and return the authorize URL
 *  (PKCE — no client secret involved). */
async function startOauthListener(clientId) {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const server = http.createServer();
  try {
    await listenOn(server, OAUTH_PORT);
  } catch {
    throw new Error(
      `Port ${OAUTH_PORT} is in use — close whatever holds it and press the login button again.`,
    );
  }
  beginLogin(server, state);
  server.on("request", (request, response) => {
    void handleOauthCallback(request, response, { clientId, state, verifier }).catch((e) => {
      log(`oauth callback failed: ${e}`);
      respondHtml(response, 500, page("Something went wrong", String(e)));
    });
  });
  log(`OAuth listener on ${OAUTH_REDIRECT}`);
  return (
    `${LINEAR_OAUTH_AUTHORIZE}?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}` +
    `&response_type=code&scope=${encodeURIComponent(OAUTH_SCOPE)}` +
    `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256` +
    "&prompt=consent"
  );
}

async function handleOauthCallback(request, response, { clientId, state, verifier }) {
  const url = new URL(request.url, `http://localhost:${OAUTH_PORT}`);
  if (url.pathname !== "/callback" || request.method !== "GET") {
    return respondHtml(response, 404, page("Not found", "This little server only does sign-in."));
  }
  if (url.searchParams.get("state") !== state) {
    return respondHtml(response, 403, page("Rejected", "State mismatch — press the login button again."));
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return respondHtml(response, 400, page("Cancelled", "Linear sent no code — nothing was changed."));
  }
  saveTokens(await exchangeCode(clientId, code, verifier));
  finishLogin(response);
}

/** First run only: no OAuth app yet. Serve the walkthrough page; when
 *  the Client ID is pasted, hand the SAME browser tab straight into the
 *  real Linear login. */
async function startSetupListener() {
  const state = crypto.randomBytes(16).toString("hex");
  const server = http.createServer();
  await listenOn(server, 0);
  const port = server.address().port;
  beginLogin(server, state);
  server.on("request", (request, response) => {
    void handleSetupRequest(request, response, { state, port }).catch((e) => {
      log(`setup request failed: ${e}`);
      respondHtml(response, 500, page("Something went wrong", String(e)));
    });
  });
  openBrowser(`http://127.0.0.1:${port}/setup?s=${state}`);
  log(`one-time setup page on port ${port}`);
}

async function handleSetupRequest(request, response, { state, port }) {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);

  if (url.pathname === "/setup" && request.method === "GET") {
    if (url.searchParams.get("s") !== state) {
      return respondHtml(response, 403, page("Rejected", "Stale link — press the login button again."));
    }
    return respondHtml(response, 200, setupPage(state));
  }

  if (url.pathname === "/save-client" && request.method === "POST") {
    const form = new URLSearchParams(await readBody(request));
    if (form.get("s") !== state) {
      return respondHtml(response, 403, page("Rejected", "Stale form — press the login button again."));
    }
    const clientId = (form.get("clientId") || "").trim();
    if (!clientId) {
      return respondHtml(response, 200, setupPage(state, "Paste the Client ID first."));
    }
    saveConfig({ oauth: { ...(readConfig().oauth || {}), clientId } });
    // Swap listeners: the OAuth one must own its fixed port before this
    // tab is sent to Linear (which will bounce it back to /callback).
    const previous = takeoverLogin();
    const authorizeUrl = await startOauthListener(clientId).catch((e) => {
      respondHtml(response, 200, setupPage(state, String(e.message || e)));
      return null;
    });
    closeSoon(previous);
    if (authorizeUrl) {
      response.writeHead(302, { Location: authorizeUrl });
      response.end();
    }
    return;
  }

  if (url.pathname === "/save" && request.method === "POST") {
    const form = new URLSearchParams(await readBody(request));
    if (form.get("s") !== state) {
      return respondHtml(response, 403, page("Rejected", "Stale form — press the login button again."));
    }
    const key = (form.get("key") || "").trim();
    if (!key) {
      return respondHtml(response, 200, setupPage(state, "Paste a key first."));
    }
    try {
      await linear(key, "query { viewer { id } }");
    } catch (e) {
      return respondHtml(response, 200, setupPage(state, `Linear rejected that key: ${e.message}`));
    }
    saveConfig({ apiKey: key, accessToken: undefined, refreshToken: undefined });
    finishLogin(response);
    return;
  }

  respondHtml(response, 404, page("Not found", "This little server only does sign-in."));
}

function finishLogin(response) {
  respondHtml(
    response,
    200,
    page("Signed in ✓", "You can close this tab — Mota's Linear panel is refreshing itself."),
  );
  statesByTeam = null;
  endLogin("completed");
  sendPanelsRefresh();
}

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function beginLogin(server, state) {
  const timer = setTimeout(() => endLogin("timed out"), LOGIN_WINDOW_MS);
  timer.unref();
  login = { server, state, timer };
}

/** Detach the current login (its response may still be flushing) so a
 *  successor can take over; close the old server a beat later. */
function takeoverLogin() {
  const current = login;
  login = null;
  if (current) clearTimeout(current.timer);
  return current;
}

function closeSoon(previous) {
  if (!previous) return;
  setTimeout(() => previous.server.close(), 1000).unref();
}

function endLogin(why) {
  if (!login) return;
  clearTimeout(login.timer);
  login.server.close();
  login = null;
  log(`login window closed (${why})`);
}

function sendPanelsRefresh() {
  outgoingId += 1;
  send({
    jsonrpc: "2.0",
    id: outgoingId,
    method: "panels/refresh",
    params: { panelId: "tasks" },
  });
}

async function exchangeCode(clientId, code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: OAUTH_REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  const clientSecret = (readConfig().oauth || {}).clientSecret;
  if (clientSecret) body.set("client_secret", clientSecret);
  const response = await fetch(LINEAR_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed (HTTP ${response.status}).`);
  }
  return response.json();
}

function openBrowser(url) {
  if (process.env.MOTA_LINEAR_NO_BROWSER) {
    log(`would open browser: ${url}`);
    return;
  }
  // rundll32 handles URLs with & reliably; cmd's `start` would need
  // shell quoting that spawn argv does not provide.
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error("Body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function respondHtml(response, status, html) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function page(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>${title} · Mota Linear</title>
<body style="font-family:system-ui;max-width:26rem;margin:14vh auto;line-height:1.5">
<h2>${title}</h2><p>${message}</p></body>`;
}

function setupPage(state, notice) {
  return `<!doctype html><meta charset="utf-8"><title>Connect Linear · Mota</title>
<body style="font-family:system-ui;max-width:30rem;margin:12vh auto;line-height:1.6">
<h2>Connect Linear to Mota</h2>
<p>One-time setup — after this it's a single click straight into
Linear's own login. Linear requires every app to be registered, so:</p>
<ol>
<li><a href="${LINEAR_NEW_APP_PAGE}" target="_blank" rel="noreferrer">Create the
 OAuth application</a> in your Linear workspace (name it "Mota Editor",
 any icon).</li>
<li>Set its <b>callback URL</b> to exactly:<br>
 <code style="user-select:all">${OAUTH_REDIRECT}</code></li>
<li>Copy the app's <b>Client ID</b> and paste it below — no secret
 needed, and this is the last thing you'll ever paste.</li>
</ol>
${notice ? `<p style="color:#b00">${notice}</p>` : ""}
<form method="post" action="/save-client">
<input type="hidden" name="s" value="${state}">
<input name="clientId" placeholder="Client ID" autofocus autocomplete="off"
 style="width:100%;padding:.5rem;font-size:1rem;box-sizing:border-box">
<button type="submit" style="margin-top:.75rem;padding:.5rem 1.25rem;font-size:1rem">
Continue to Linear login</button>
</form>
<details style="margin-top:2rem"><summary>Prefer a personal API key instead?</summary>
<p><a href="${LINEAR_KEYS_PAGE}" target="_blank" rel="noreferrer">Create one here</a>
 and paste it — it stays on this machine.</p>
<form method="post" action="/save">
<input type="hidden" name="s" value="${state}">
<input type="password" name="key" placeholder="lin_api_…"
 style="width:100%;padding:.5rem;font-size:1rem;box-sizing:border-box">
<button type="submit" style="margin-top:.75rem;padding:.5rem 1.25rem;font-size:1rem">Save key</button>
</form></details></body>`;
}

// ---- Linear GraphQL ----

async function linear(auth, query, variables) {
  const response = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 401) {
    const unauthorized = new Error("Linear rejected the sign-in.");
    unauthorized.unauthorized = true;
    throw unauthorized;
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

async function fetchAssignedIssues(auth) {
  const data = await linear(
    auth,
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

async function teamStates(auth) {
  if (statesByTeam) return statesByTeam;
  const data = await linear(
    auth,
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

async function updateIssueState(auth, issueId, stateId) {
  const data = await linear(
    auth,
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issueId, stateId },
  );
  if (!data.issueUpdate.success) throw new Error("Linear refused the status change.");
}

async function issueDetail(auth, issueId) {
  const data = await linear(
    auth,
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
