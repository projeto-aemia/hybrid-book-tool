/**
 * Strips ASCII control characters (0-31 and 127) and matching disallowed characters from a string.
 * Avoids control character escape sequences in regular expressions to satisfy strict linting rules.
 *
 * @param input The input string.
 * @param disallowedPattern Regular expression matching additional disallowed characters.
 * @returns Sanitized string.
 */
function removeDisallowedChars(input: string, disallowedPattern: RegExp): string {
  let result = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 32 && code !== 127) {
      result += input[i];
    }
  }
  return result.replace(disallowedPattern, '');
}

/**
 * Sanitizes a file name for inclusion inside a ZIP archive to prevent path traversal and filesystem conflicts.
 *
 * @param rawName The raw file name provided by the user or file object.
 * @param fallback The fallback name if the sanitized name becomes empty.
 * @returns A safe file name containing only the base name without directory components or path traversal.
 */
export function sanitizeEntryFileName(rawName: string, fallback: string): string {
  // Extract only the base name by removing any preceding directory paths (both / and \)
  const baseName = rawName.replace(/^.*[\\/]/, '');

  // Remove control characters, null bytes, and characters illegal in common filesystems
  const cleaned = removeDisallowedChars(baseName, /[<>:"/\\|?*]/g).trim();

  // Guard against traversal names like "." or ".." or empty strings
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    return fallback;
  }

  // Strip leading dots to prevent hidden files or relative traversal
  const noLeadingDots = cleaned.replace(/^\.+/, '');
  if (noLeadingDots.length === 0) {
    return fallback;
  }

  return noLeadingDots;
}

/**
 * Sanitizes a relative entry path within a ZIP archive to prevent path traversal (Zip Slip).
 *
 * @param rawPath The proposed archive entry path.
 * @param fallback Optional fallback path if the sanitized path resolves to empty.
 * @returns A safe relative path with all traversal sequences and invalid characters resolved.
 */
export function sanitizeZipPath(rawPath: string, fallback = 'file'): string {
  const normalized = rawPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  const safeSegments: string[] = [];

  for (const seg of segments) {
    if (seg === '..') {
      safeSegments.pop();
    } else {
      // Remove control characters and dangerous filesystem characters
      const cleaned = removeDisallowedChars(seg, /[<>:"|?*]/g).trim();
      if (cleaned.length > 0 && cleaned !== '..') {
        safeSegments.push(cleaned);
      }
    }
  }

  return safeSegments.length > 0 ? safeSegments.join('/') : fallback;
}

/**
 * Sanitizes a proposed download file name to remove newlines, path separators, and illegal characters.
 *
 * @param fileName The proposed download file name.
 * @param fallback Optional fallback name if the string resolves to empty.
 * @returns A safe download file name.
 */
export function sanitizeDownloadFileName(fileName: string, fallback = 'download.zip'): string {
  const baseName = fileName.replace(/^.*[\\/]/, '');
  const cleaned = removeDisallowedChars(baseName, /[<>:"/\\|?*]/g).trim();

  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    return fallback;
  }

  const noLeadingDots = cleaned.replace(/^\.+/, '');
  return noLeadingDots.length > 0 ? noLeadingDots : fallback;
}
