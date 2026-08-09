// The Dependency Rule, made executable.
//
// Every rule here is the mechanical half of a line in
// docs/CODING_STANDARDS.md § Boundaries — that document stays the single
// source of truth; this file only enforces it. Adding a rule is an edit to
// the RULES array, nothing else.
//
// Pure by design: it takes files as `{ path, text }` and returns findings.
// Reading the tree is the caller's job (see architecture.test.mjs), which is
// what makes every rule testable with in-memory fixtures.

const STANDARD = "docs/CODING_STANDARDS.md § Boundaries";

/** The module specifier of an import, or null for any other line. */
const importedModule = (line) => {
  const match =
    line.match(/^\s*(?:import|export)\b[^"']*\bfrom\s*["']([^"']+)["']/) ??
    line.match(/^\s*import\s*["']([^"']+)["']/) ??
    line.match(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/);
  return match ? match[1] : null;
};

const scan = (text, toMessage) => {
  const violations = [];
  text.split("\n").forEach((line, index) => {
    const message = toMessage(line);
    if (message) violations.push({ line: index + 1, message });
  });
  return violations;
};

const scanImports = (text, toMessage) =>
  scan(text, (line) => {
    const module = importedModule(line);
    return module ? toMessage(module) : null;
  });

// --- core purity -------------------------------------------------------

const FORBIDDEN_IN_CORE = [
  { label: "React", pattern: /^react(-dom)?(\/|$)/ },
  { label: "Tauri", pattern: /^@tauri-apps\// },
  { label: "an outer layer", pattern: /(^|\/)(adapters|ui|wiring)\// },
];

const corePurity = {
  name: "core-purity",
  check: (file) => {
    if (!file.path.startsWith("src/core/")) return [];
    return scanImports(file.text, (module) => {
      const forbidden = FORBIDDEN_IN_CORE.find(({ pattern }) => pattern.test(module));
      return forbidden && `src/core must not import ${forbidden.label} ("${module}")`;
    });
  },
};

// --- composition root --------------------------------------------------

// Deliberately strict, including in tests: use cases are tested through
// their ports with hand-written fakes, never with the shipped adapters.
const compositionRoot = {
  name: "composition-root",
  check: (file) => {
    if (!file.path.startsWith("src/") || file.path.startsWith("src/wiring/")) return [];
    return scan(file.text, (line) => {
      const constructed = line.match(/\bnew\s+((?:Tauri|Demo)[A-Z]\w*)\s*\(/);
      return (
        constructed &&
        `${constructed[1]} may only be constructed in src/wiring/ (the composition root)`
      );
    });
  },
};

// --- agent-core purity -------------------------------------------------

const AGENT_CORE = "src-tauri/agent-core";
const ALLOWED_CRATES = ["serde", "serde_json"];
const FORBIDDEN_RUST_USE = /^\s*use\s+(tauri|tokio|std::(?:fs|process|net|io))\b/;

const forbiddenCrates = (text) => {
  const violations = [];
  let inDependencies = false;
  text.split("\n").forEach((line, index) => {
    const table = line.match(/^\s*\[([^\]]+)\]/);
    if (table) {
      inDependencies = table[1] === "dependencies";
      return;
    }
    const crate = inDependencies && line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (crate && !ALLOWED_CRATES.includes(crate[1])) {
      violations.push({
        line: index + 1,
        message: `agent-core must not depend on ${crate[1]} — it stays pure (serde only)`,
      });
    }
  });
  return violations;
};

const agentCorePurity = {
  name: "agent-core-purity",
  check: (file) => {
    if (file.path === `${AGENT_CORE}/Cargo.toml`) return forbiddenCrates(file.text);
    if (!file.path.startsWith(`${AGENT_CORE}/src/`)) return [];
    return scan(file.text, (line) => {
      const used = line.match(FORBIDDEN_RUST_USE);
      return used && `agent-core must not use ${used[1]} — no I/O, no Tauri, no tokio`;
    });
  },
};

// --- ui and adapters ---------------------------------------------------

// `isTauriRuntime` answers "am I inside the webview?". It implements no
// port and holds no vendor state, so importing it does not couple a view
// to an adapter.
const NOT_AN_ADAPTER = ["adapters/tauri/runtime"];

const humbleViews = {
  name: "humble-views",
  check: (file) => {
    if (!file.path.startsWith("src/ui/")) return [];
    return scanImports(file.text, (module) => {
      if (!/(^|\/)adapters\//.test(module)) return null;
      if (NOT_AN_ADAPTER.some((exempt) => module.endsWith(exempt))) return null;
      return `src/ui must not import adapters ("${module}") — wire it in src/wiring/`;
    });
  },
};

export const RULES = [corePurity, compositionRoot, agentCorePurity, humbleViews];

/**
 * Every boundary violation in the given files.
 *
 * @param {{ path: string, text: string }[]} files repo-relative, `/`-separated
 * @returns {{ path: string, line: number, rule: string, message: string, standard: string }[]}
 */
export function findViolations(files) {
  return files.flatMap((file) =>
    RULES.flatMap((rule) =>
      rule.check(file).map((violation) => ({
        path: file.path,
        rule: rule.name,
        standard: STANDARD,
        ...violation,
      })),
    ),
  );
}
