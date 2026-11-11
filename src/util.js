export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Coerce any value to a bounded string. */
export function str(value, max = 1000) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  return String(value).slice(0, max);
}

export function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Normalise a RustDesk peer ID (numeric or custom alphanumeric). */
export function cleanId(value) {
  return str(value, 100).trim();
}

export function cleanIp(value) {
  return str(value, 64).trim().replace(/^::ffff:/, '');
}

export function paging(query, { defaultSize = 25, maxSize = 200 } = {}) {
  const page = Math.max(1, intOrNull(query.get('page') ?? query.get('current')) ?? 1);
  const requested = intOrNull(query.get('pageSize')) ?? defaultSize;
  const pageSize = Math.min(maxSize, Math.max(1, requested));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Build a `%term%` LIKE pattern; use with `ESCAPE '\'`. */
export function likePattern(term) {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

export function parseJson(text, fallback) {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
