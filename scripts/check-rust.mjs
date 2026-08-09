// Preflight for `npm run tauri`: fail with a readable message when the Rust
// toolchain is missing.
//
// Without this, the Tauri CLI shells out to `cargo metadata` and surfaces the
// raw ENOENT ("No such file or directory (os error 2)"), which names neither
// the missing tool nor the fix. Prerequisites live in README → Development.

import { spawnSync } from "node:child_process";
import { platform } from "node:process";

const INSTALL = {
  darwin:
    "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\n" +
    '  source "$HOME/.cargo/env"',
  linux:
    "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\n" +
    '  source "$HOME/.cargo/env"',
  win32: "  Download and run https://win.rustup.rs/x86_64",
};

const found = spawnSync("cargo", ["--version"], { stdio: "ignore" }).status === 0;

if (!found) {
  const install = INSTALL[platform] ?? INSTALL.linux;
  console.error(
    [
      "",
      "Rust toolchain not found — `cargo` is not on PATH.",
      "",
      "The Tauri CLI needs it to build src-tauri/. Install it with rustup:",
      "",
      install,
      "",
      "then re-run this command. See README → Development for the full",
      "prerequisite list (Xcode Command Line Tools on macOS, WebView2 and",
      "MSVC Build Tools on Windows, webkit2gtk on Linux).",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
