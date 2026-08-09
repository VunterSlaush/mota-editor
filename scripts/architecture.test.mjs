// Executable form of docs/CODING_STANDARDS.md § Boundaries.
//
// Two halves: the unit tests below prove each rule can actually fire (a
// checker that cannot be shown to fail is worthless), and the final block
// walks the real tree and asserts it is clean.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findViolations } from "./architecture.mjs";

const messagesFor = (filePath, text) =>
  findViolations([{ path: filePath, text }]).map((violation) => violation.message);

describe("core purity", () => {
  it("rejects React in the core", () => {
    expect(
      messagesFor("src/core/entities/project.ts", `import { useState } from "react";`),
    ).toHaveLength(1);
  });

  it("rejects Tauri in the core", () => {
    expect(
      messagesFor(
        "src/core/usecases/sendPrompt.ts",
        `import { invoke } from "@tauri-apps/api";`,
      ),
    ).toHaveLength(1);
  });

  it("rejects an outward import into adapters, ui, or wiring", () => {
    const outward = [
      `import { TauriGitStatus } from "../../adapters/tauri/tauriGitStatus";`,
      `import { App } from "../../ui/App";`,
      `import { createAppContext } from "../../wiring/context";`,
    ];
    for (const line of outward) {
      expect(messagesFor("src/core/usecases/openProject.ts", line)).toHaveLength(1);
    }
  });

  it("allows the core to import its own ports and entities", () => {
    expect(
      messagesFor(
        "src/core/usecases/sendPrompt.ts",
        `import type { AgentGateway } from "../ports/agentGateway";`,
      ),
    ).toEqual([]);
  });

  it("ignores the same words outside an import", () => {
    expect(
      messagesFor(
        "src/core/entities/message.ts",
        `// the react-style reducer lives here`,
      ),
    ).toEqual([]);
  });
});

describe("composition root", () => {
  it("rejects adapter construction outside src/wiring", () => {
    expect(
      messagesFor("src/ui/App.tsx", `  const git = new TauriGitStatus();`),
    ).toHaveLength(1);
  });

  it("allows adapter construction inside src/wiring", () => {
    expect(
      messagesFor("src/wiring/context.ts", `  const git = new TauriGitStatus();`),
    ).toEqual([]);
  });

  it("leaves ordinary constructors alone", () => {
    expect(messagesFor("src/ui/App.tsx", `  const store = new Store();`)).toEqual([]);
  });
});

describe("agent-core purity", () => {
  const manifest = "src-tauri/agent-core/Cargo.toml";

  it("rejects a dependency beyond serde", () => {
    const text = ["[dependencies]", `serde = { version = "1" }`, `tokio = "1"`].join(
      "\n",
    );
    expect(messagesFor(manifest, text)).toHaveLength(1);
  });

  it("allows serde and serde_json", () => {
    const text = ["[dependencies]", `serde = "1"`, `serde_json = "1"`].join("\n");
    expect(messagesFor(manifest, text)).toEqual([]);
  });

  it("only inspects the dependencies table", () => {
    const text = ["[package]", `name = "agent-core"`, `edition = "2021"`].join("\n");
    expect(messagesFor(manifest, text)).toEqual([]);
  });

  it("rejects I/O and framework imports in its sources", () => {
    const forbidden = [
      "use tauri::Manager;",
      "use tokio::process::Command;",
      "use std::fs;",
    ];
    for (const line of forbidden) {
      expect(messagesFor("src-tauri/agent-core/src/turn.rs", line)).toHaveLength(1);
    }
  });

  it("allows the pure standard library", () => {
    expect(
      messagesFor("src-tauri/agent-core/src/turn.rs", "use std::collections::HashMap;"),
    ).toEqual([]);
  });
});

describe("ui and adapters", () => {
  it("rejects an adapter import in the UI", () => {
    expect(
      messagesFor(
        "src/ui/ChatPanel.tsx",
        `import { TauriGitStatus } from "../adapters/tauri/tauriGitStatus";`,
      ),
    ).toHaveLength(1);
  });

  it("allows the runtime probe, which implements no port", () => {
    expect(
      messagesFor(
        "src/ui/openFile.ts",
        `import { isTauriRuntime } from "../adapters/tauri/runtime";`,
      ),
    ).toEqual([]);
  });
});

// --- the real tree -----------------------------------------------------

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));

const SCANNED_TREES = [
  { directory: "src", extensions: [".ts", ".tsx"] },
  { directory: "src-tauri/agent-core/src", extensions: [".rs"] },
];
const SCANNED_FILES = ["src-tauri/agent-core/Cargo.toml"];

const filesUnder = (directory) =>
  fs
    .readdirSync(path.join(REPOSITORY, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = `${directory}/${entry.name}`;
      return entry.isDirectory() ? filesUnder(relative) : [relative];
    });

const readRepository = () => {
  const scanned = SCANNED_TREES.flatMap(({ directory, extensions }) =>
    filesUnder(directory).filter((file) => extensions.some((ext) => file.endsWith(ext))),
  );
  return [...scanned, ...SCANNED_FILES].map((file) => ({
    path: file,
    text: fs.readFileSync(path.join(REPOSITORY, file), "utf8"),
  }));
};

const describeViolation = ({ path: file, line, rule, message, standard }) =>
  `${file}:${line}: [${rule}] ${message} — see ${standard}`;

describe("the repository", () => {
  it("scans every source file the rules govern", () => {
    expect(readRepository().length).toBeGreaterThan(50);
  });

  it("obeys the Dependency Rule", () => {
    expect(findViolations(readRepository()).map(describeViolation)).toEqual([]);
  });
});
