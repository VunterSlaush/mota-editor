/** Whether Jev can be reached — never the key itself. */
export interface JevKeyStatus {
  readonly configured: boolean;
  /** `file`: saved in Settings. `env`: TYPESAFE_API_KEY. `none`: neither. */
  readonly source: "file" | "env" | "none";
  /** Jev travels over the system curl; without it the key is useless. */
  readonly curlFound: boolean;
}

/**
 * Ports layer — the Jev API key, held by the backend (ADR-0025).
 *
 * Write-only from here: a key can be saved or removed, and its presence
 * asked about, but never read back. The webview has no network and no
 * need for the secret, so it never gets one to leak.
 */
export interface JevKeyStore {
  status(): Promise<JevKeyStatus>;
  setKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
}
