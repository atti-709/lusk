// Run version names: `<nn>-<tag>` (01-v0, 02-cs-large-v3), never a bare "v1" that two workstreams reuse.
export const VERSION_PATTERN = /^\d{2}-[a-z0-9-]+$/;

export function isValidVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}
