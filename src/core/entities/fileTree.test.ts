import { describe, expect, it } from "vitest";
import { buildFileTree, fileKind, visibleRows } from "./fileTree";

/** Names at the top level, in the order the tree puts them. */
const topNames = (paths: readonly string[]) =>
  buildFileTree(paths).map((node) => node.name);

const rowsFor = (paths: readonly string[], expanded: readonly string[] = []) =>
  visibleRows(buildFileTree(paths), new Set(expanded));

describe("buildFileTree", () => {
  it("makes one childless node per file in a flat project", () => {
    const tree = buildFileTree(["README.md", "LICENSE"]);

    expect(tree).toHaveLength(2);
    expect(tree.every((node) => node.children.length === 0)).toBe(true);
  });

  it("gathers siblings under one folder node named by its path so far", () => {
    const tree = buildFileTree(["src/a.ts", "src/b.ts"]);

    expect(tree).toHaveLength(1);
    expect(tree[0].path).toBe("src");
    expect(tree[0].name).toBe("src");
    expect(tree[0].children.map((child) => child.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("accumulates the path down a deep chain", () => {
    const [a] = buildFileTree(["a/b/c/d.ts"]);
    const b = a.children[0];
    const c = b.children[0];

    expect([a.path, b.path, c.path, c.children[0].path]).toEqual([
      "a",
      "a/b",
      "a/b/c",
      "a/b/c/d.ts",
    ]);
  });

  it("puts folders before files", () => {
    expect(topNames(["z.txt", "src/a.ts"])).toEqual(["src", "z.txt"]);
  });

  it("sorts names without letting case decide", () => {
    expect(topNames(["b.ts", "A.ts"])).toEqual(["A.ts", "b.ts"]);
  });

  it("orders names that differ only by case the same way every time", () => {
    // localeCompare calls these equal, so something else has to break the
    // tie or the tree would shuffle between platforms.
    expect(topNames(["README.md", "readme.md"])).toEqual(
      topNames(["readme.md", "README.md"]),
    );
  });

  it("does not care what order git listed the paths in", () => {
    // git ls-files appends --others after --cached, so the input really is
    // unsorted: the sort is what makes the tree stable, not the input.
    const paths = ["src/ui/App.tsx", "README.md", "src/core/store.ts", "docs/adr.md"];

    expect(buildFileTree(paths)).toEqual(buildFileTree([...paths].reverse()));
  });

  it("has nothing to show for no paths", () => {
    expect(buildFileTree([])).toEqual([]);
  });

  it("treats a backslash as part of the name, not a separator", () => {
    // git speaks forward slashes on every platform, and a backslash is a
    // legal character in a file name — splitting on it would invent a folder.
    const tree = buildFileTree(["weird\\name.ts"]);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("weird\\name.ts");
    expect(tree[0].children).toEqual([]);
  });

  it("never makes a nameless node out of a malformed path", () => {
    const tree = buildFileTree(["", "a//b.ts", "trailing/"]);
    const names: string[] = [];
    const walk = (nodes: ReturnType<typeof buildFileTree>) => {
      for (const node of nodes) {
        names.push(node.name);
        walk(node.children);
      }
    };
    walk(tree);

    expect(names).not.toContain("");
    expect(names).toContain("b.ts");
  });
});

describe("fileKind", () => {
  it("knows the languages the project is written in", () => {
    expect(fileKind("App.tsx")).toBe("tsx");
    expect(fileKind("store.ts")).toBe("ts");
    expect(fileKind("main.rs")).toBe("rust");
    expect(fileKind("styles.css")).toBe("style");
    expect(fileKind("index.html")).toBe("markup");
    expect(fileKind("tauri.conf.json")).toBe("data");
    expect(fileKind("README.md")).toBe("markdown");
    expect(fileKind("icon.png")).toBe("image");
  });

  it("reads several spellings of the same language as one kind", () => {
    expect([fileKind("a.js"), fileKind("a.mjs"), fileKind("a.cjs")]).toEqual([
      "js",
      "js",
      "js",
    ]);
    expect([fileKind("a.yml"), fileKind("a.yaml"), fileKind("a.toml")]).toEqual([
      "data",
      "data",
      "data",
    ]);
  });

  it("does not care how the extension is capitalised", () => {
    expect(fileKind("PHOTO.PNG")).toBe("image");
  });

  it("reads the last extension, not the first", () => {
    expect(fileKind("appState.test.ts")).toBe("ts");
  });

  it("has a plain kind for everything it does not recognise", () => {
    expect(fileKind("Dockerfile")).toBe("plain");
    expect(fileKind("LICENSE")).toBe("plain");
    expect(fileKind("archive.xyz")).toBe("plain");
  });

  it("treats a dotfile as a name, not as an extension", () => {
    // ".gitignore" is not a gitignore-flavoured file: it has no extension.
    expect(fileKind(".gitignore")).toBe("plain");
  });
});

describe("visibleRows", () => {
  const PROJECT = ["README.md", "src/ui/App.tsx", "src/core/store.ts"];

  it("shows the top level only while everything is collapsed", () => {
    expect(rowsFor(PROJECT)).toEqual([
      { path: "src", name: "src", depth: 0, isDirectory: true },
      { path: "README.md", name: "README.md", depth: 0, isDirectory: false },
    ]);
  });

  it("puts an expanded folder's children right under it, one level deeper", () => {
    expect(rowsFor(PROJECT, ["src"])).toEqual([
      { path: "src", name: "src", depth: 0, isDirectory: true },
      { path: "src/core", name: "core", depth: 1, isDirectory: true },
      { path: "src/ui", name: "ui", depth: 1, isDirectory: true },
      { path: "README.md", name: "README.md", depth: 0, isDirectory: false },
    ]);
  });

  it("keeps a folder's contents hidden while an ancestor is collapsed", () => {
    const rows = rowsFor(PROJECT, ["src/ui"]);

    expect(rows.map((row) => row.path)).toEqual(["src", "README.md"]);
  });

  it("gains one level of depth per folder opened", () => {
    const rows = rowsFor(PROJECT, ["src", "src/ui"]);

    expect(rows.find((row) => row.path === "src/ui/App.tsx")?.depth).toBe(2);
  });

  it("ignores a path that is no longer in the tree", () => {
    // Refreshing keeps the expanded set, so it can name a deleted folder.
    expect(rowsFor(PROJECT, ["gone", "src"])).toEqual(rowsFor(PROJECT, ["src"]));
  });

  it("gives every row its own path, so each one can be a React key", () => {
    const rows = rowsFor(["a/x.ts", "b/x.ts"], ["a", "b"]);
    const paths = rows.map((row) => row.path);

    expect(new Set(paths).size).toBe(paths.length);
  });
});
