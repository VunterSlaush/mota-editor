/**
 * Port — the files in a folder, read from the disk itself.
 *
 * Git answers this faster and better wherever it can: `git ls-files` already
 * knows what is ignored, so the listing costs no ignore rules of our own.
 * This is the answer for the folder git knows nothing about — a project that
 * was never a repository — where the alternative is showing the user an
 * empty tree of their own files.
 */
export interface ProjectFiles {
  /**
   * Every file under `projectPath`, as project-relative paths with forward
   * slashes. Heavy folders nobody browses (`node_modules`, build output)
   * are skipped, and a folder that cannot be read is simply empty: an
   * unreadable directory is a normal state, not an error.
   */
  walk(projectPath: string): Promise<string[]>;
}
