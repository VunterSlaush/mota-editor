// One version, in three files that cannot see each other.
//
// The UI shows package.json's version (Vite bakes it in), the installer
// and the window's file properties carry tauri.conf.json's, and the ACP
// handshake tells every agent Cargo.toml's. Nothing makes them agree, and
// nothing would notice if they stopped — an app that reports a version it
// is not is worse than one that reports none.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const packageVersion = () => JSON.parse(read("package.json")).version;
const tauriConfVersion = () => JSON.parse(read("src-tauri/tauri.conf.json")).version;

/** The `version` of the crate itself — the first one in the file, which
 *  is the package table, not a dependency's. */
const cargoVersion = () =>
  read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1];

describe("the app's version", () => {
  it("is a plain semver in package.json", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is the same one the bundle and the window properties carry", () => {
    expect(tauriConfVersion()).toBe(packageVersion());
  });

  it("is the same one the Rust crate reports to agents", () => {
    expect(cargoVersion()).toBe(packageVersion());
  });
});
