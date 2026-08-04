import type { Action, AppState } from "./appState";
import { initialState, reduce } from "./appState";

/**
 * Core state — a minimal observable store. Framework-free by design:
 * React subscribes through an adapter hook, tests subscribe directly.
 */
export type Listener = () => void;

export class Store {
  private state: AppState = initialState;
  private listeners = new Set<Listener>();

  getState(): AppState {
    return this.state;
  }

  dispatch(action: Action): void {
    this.state = reduce(this.state, action);
    this.listeners.forEach((l) => l());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
