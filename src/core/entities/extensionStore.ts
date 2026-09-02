/**
 * Entities layer — where extensions come from.
 *
 * The store is an ordinary public repository: `registry.json` is the
 * index, and each entry either points at a folder inside it or at the
 * author's own clone URL. Nothing here talks to it — these are the two
 * addresses, in one place, so the guide the agent follows and anything
 * that browses the index later cannot drift apart.
 */

export const STORE_REPO_URL = "https://github.com/VunterSlaush/mota-extensions";

/** The raw index. Pinned to `main`: the store's own README promises the
 *  shape is versioned and additive, so a reader never needs a tag. */
export const STORE_REGISTRY_URL =
  "https://raw.githubusercontent.com/VunterSlaush/mota-extensions/main/registry.json";
