/**
 * Port — the files in a folder, read from the disk itself.
 *
 * This is the listing, for a repository and a plain folder alike. Git could
 * answer it, and once did, but it answers with `.gitignore` applied: no
 * `.env`, nothing under `dist/`, and no way to ask again. The disk knows
 * what is actually there.
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
