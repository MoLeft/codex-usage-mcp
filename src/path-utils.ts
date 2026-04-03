import path from "node:path";

function shouldCompareCaseInsensitive(value: string): boolean {
  return process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(value);
}

export function normalizeComparablePath(value: string): string {
  const normalized = path.normalize(value).replace(/\\/g, "/");
  return shouldCompareCaseInsensitive(value) ? normalized.toLowerCase() : normalized;
}

export function pathMatchesPrefix(target: string | null, prefix: string | null | undefined): boolean {
  if (!prefix) return true;
  if (!target) return false;

  const normalizedTarget = normalizeComparablePath(target);
  const normalizedPrefix = normalizeComparablePath(prefix);
  if (normalizedTarget === normalizedPrefix) return true;
  return normalizedTarget.startsWith(`${normalizedPrefix}/`);
}

export function projectLabelFromCwd(cwd: string | null): string {
  if (!cwd) return "unknown";
  const baseName = path.basename(cwd.replace(/[\\/]+$/, ""));
  return baseName || cwd;
}
