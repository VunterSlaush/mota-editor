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
