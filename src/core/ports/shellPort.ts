/**
 * Ports layer — boundary for the user's terminal. The core decides which
 * folder a shell opens in and when it dies; how a pty is opened, and on
 * which operating system, is the adapter's business.
 */

/** How big the shell believes its window is, in character cells. */
export interface ShellSize {
  readonly cols: number;
  readonly rows: number;
}

export interface ShellOpenRequest {
  /** Kills are grouped by project: closing a tab closes its terminals. */
  readonly projectId: string;
  readonly cwd: string;
  /** The shell configured in Settings. A program path, never a command
   *  line — the adapter resolves and spawns it, nothing interpolates it. */
  readonly shellPath?: string;
  readonly size: ShellSize;
}

/**
 * Where a running shell's output goes.
 *
 * Bytes, not text: a chunk boundary lands mid-character often enough
 * that decoding per chunk would corrupt output, and the terminal
 * emulator on the other end stitches them anyway.
 */
export interface ShellStream {
  readonly onOutput: (bytes: Uint8Array) => void;
  /** `code` is null when the shell was killed rather than returning. */
  readonly onExit: (code: number | null) => void;
}

export interface ShellPort {
  /** Resolves with the new session's id once the shell is running. */
  open(request: ShellOpenRequest, stream: ShellStream): Promise<string>;
  /** Keystrokes, verbatim — including the control characters that make
   *  Ctrl+C and the arrow keys work. */
  write(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, size: ShellSize): Promise<void>;
  close(sessionId: string): Promise<void>;
  /** Every shell of one project, for tab close and worktree removal. */
  closeProject(projectId: string): Promise<void>;
}
