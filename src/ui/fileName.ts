/** UI helper — the file name segment of a full path (any OS separator). */
export function fileName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}
