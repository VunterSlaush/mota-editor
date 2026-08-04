import { useSyncExternalStore } from "react";
import type { AppState } from "../core/state/appState";
import type { Store } from "../core/state/store";

/**
 * UI adapter — bridges the framework-free Store to React.
 * The only place React learns how to observe core state.
 */
export function useAppState(store: Store): AppState {
  return useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.getState(),
  );
}
