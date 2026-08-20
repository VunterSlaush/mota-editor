import { describe, expect, it } from "vitest";
import { parsePanelActionResult, parsePanelView } from "./extensionPanels";

describe("parsePanelView", () => {
  it("parses groups, items, badges, and selects", () => {
    const view = parsePanelView({
      groups: [
        {
          title: "In Progress",
          items: [
            {
              id: "iss-1",
              title: "Fix login",
              subtitle: "ENG-123",
              badge: "Urgent",
              select: {
                selectedId: "started",
                options: [
                  { id: "todo", label: "Todo" },
                  { id: "started", label: "In Progress" },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(view.groups).toHaveLength(1);
    const item = view.groups[0]?.items[0];
    expect(item?.title).toBe("Fix login");
    expect(item?.badge).toBe("Urgent");
    expect(item?.select?.options).toHaveLength(2);
    expect(item?.select?.selectedId).toBe("started");
  });

  it("degrades malformed entries to a smaller view, never a failure", () => {
    const view = parsePanelView({
      groups: [
        "not a group",
        { items: [] }, // no title
        {
          title: "Ok",
          items: [{ id: "a" }, { title: "no id" }, { id: "b", title: "Kept" }],
        },
      ],
      emptyText: 42,
    });
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]?.items).toEqual([{ id: "b", title: "Kept" }]);
    expect(view.emptyText).toBeUndefined();
  });

  it("handles a non-object payload as an empty view", () => {
    expect(parsePanelView(null).groups).toEqual([]);
    expect(parsePanelView("hi").groups).toEqual([]);
  });

  it("caps sizes rather than trusting the extension", () => {
    const view = parsePanelView({
      groups: Array.from({ length: 50 }, (_, i) => ({
        title: `G${i}`,
        items: Array.from({ length: 200 }, (_, j) => ({
          id: `i${j}`,
          title: "x".repeat(1000),
        })),
      })),
    });
    expect(view.groups).toHaveLength(20);
    expect(view.groups[0]?.items).toHaveLength(100);
    expect(view.groups[0]?.items[0]?.title).toHaveLength(200);
  });

  it("parses panel-level buttons, dropping malformed ones", () => {
    const view = parsePanelView({
      buttons: [{ id: "login", label: "Log in with Linear" }, { id: "" }, "junk"],
    });
    expect(view.buttons).toEqual([{ id: "login", label: "Log in with Linear" }]);
  });

  it("caps buttons at five", () => {
    const view = parsePanelView({
      buttons: Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, label: `B${i}` })),
    });
    expect(view.buttons).toHaveLength(5);
  });

  it("keeps checked only when it is a boolean", () => {
    const view = parsePanelView({
      groups: [
        {
          title: "G",
          items: [
            { id: "a", title: "Done", checked: true },
            { id: "b", title: "Open", checked: false },
            { id: "c", title: "No box", checked: "yes" },
          ],
        },
      ],
    });
    const items = view.groups[0]?.items;
    expect(items?.[0]?.checked).toBe(true);
    expect(items?.[1]?.checked).toBe(false);
    expect(items?.[2]?.checked).toBeUndefined();
  });

  it("keeps removable only when it is exactly true", () => {
    const view = parsePanelView({
      groups: [
        {
          title: "G",
          items: [
            { id: "a", title: "Deletable", removable: true },
            { id: "b", title: "Not", removable: "yes" },
            { id: "c", title: "Also not" },
          ],
        },
      ],
    });
    const items = view.groups[0]?.items;
    expect(items?.[0]?.removable).toBe(true);
    expect(items?.[1]?.removable).toBeUndefined();
    expect(items?.[2]?.removable).toBeUndefined();
  });

  it("parses a panel-level input, dropping one without an id", () => {
    const view = parsePanelView({
      input: { id: "new-todo", placeholder: "Add a todo…" },
    });
    expect(view.input).toEqual({ id: "new-todo", placeholder: "Add a todo…" });

    expect(parsePanelView({ input: { placeholder: "no id" } }).input).toBeUndefined();
    expect(parsePanelView({ input: "junk" }).input).toBeUndefined();
    expect(parsePanelView({}).input).toBeUndefined();
  });

  it("keeps a known badge tone and drops an invented one", () => {
    const view = parsePanelView({
      groups: [
        {
          title: "G",
          items: [
            { id: "a", title: "Red", badge: "✗ 2", badgeTone: "danger" },
            { id: "b", title: "Green", badge: "✓ 14", badgeTone: "success" },
            { id: "c", title: "Made up", badge: "?", badgeTone: "chartreuse" },
            { id: "d", title: "Not a string", badge: "?", badgeTone: 7 },
          ],
        },
      ],
    });
    const items = view.groups[0]?.items;
    expect(items?.[0]?.badgeTone).toBe("danger");
    expect(items?.[1]?.badgeTone).toBe("success");
    // An unknown tone loses the colour, never the badge itself.
    expect(items?.[2]?.badgeTone).toBeUndefined();
    expect(items?.[2]?.badge).toBe("?");
    expect(items?.[3]?.badgeTone).toBeUndefined();
  });

  it("parses an item menu, dropping malformed entries and capping the rest", () => {
    const view = parsePanelView({
      groups: [
        {
          title: "G",
          items: [
            {
              id: "a",
              title: "Has a menu",
              menu: [{ id: "hide", label: "Hide acme/web" }, { id: "no-label" }, "junk"],
            },
            { id: "b", title: "No menu" },
            { id: "c", title: "Nothing usable", menu: [{ id: "" }] },
            {
              id: "d",
              title: "Too many",
              menu: Array.from({ length: 30 }, (_, i) => ({
                id: `m${i}`,
                label: `M${i}`,
              })),
            },
          ],
        },
      ],
    });
    const items = view.groups[0]?.items;
    expect(items?.[0]?.menu).toEqual([{ id: "hide", label: "Hide acme/web" }]);
    expect(items?.[1]?.menu).toBeUndefined();
    // Empty is undefined, so "has a menu" stays one truthiness check.
    expect(items?.[2]?.menu).toBeUndefined();
    expect(items?.[3]?.menu).toHaveLength(10);
  });

  it("drops a select without usable options", () => {
    const view = parsePanelView({
      groups: [
        {
          title: "G",
          items: [{ id: "a", title: "A", select: { selectedId: "x", options: ["bad"] } }],
        },
      ],
    });
    expect(view.groups[0]?.items[0]?.select).toBeUndefined();
  });
});

describe("parsePanelActionResult", () => {
  it("carries an updated view, a detail, both, or neither", () => {
    expect(parsePanelActionResult({}).view).toBeUndefined();
    expect(parsePanelActionResult({}).detail).toBeUndefined();

    const both = parsePanelActionResult({
      view: { groups: [] },
      detail: {
        title: "Fix login",
        subtitle: "ENG-123",
        fields: [{ label: "Priority", value: "Urgent" }],
        body: "Steps to reproduce…",
        url: "https://linear.app/issue/ENG-123",
      },
    });
    expect(both.view?.groups).toEqual([]);
    expect(both.detail?.title).toBe("Fix login");
    expect(both.detail?.fields).toEqual([{ label: "Priority", value: "Urgent" }]);
    expect(both.detail?.url).toBe("https://linear.app/issue/ENG-123");
  });

  it("drops non-http detail urls", () => {
    const result = parsePanelActionResult({
      detail: { title: "T", url: "file:///etc/passwd" },
    });
    expect(result.detail?.url).toBeUndefined();
  });

  it("drops a detail without a title", () => {
    expect(
      parsePanelActionResult({ detail: { body: "no title" } }).detail,
    ).toBeUndefined();
  });
});
