// Thin adapter over zod 4 for the FPL API boundary: turns a zod result into
// a capped list of "path: message" issue strings (empty when valid).

const MAX_ISSUES = 20;

const formatPath = (path) =>
  path.reduce((acc, key) => (typeof key === 'number' ? `${acc}[${key}]` : acc ? `${acc}.${key}` : String(key)), '') ||
  '<root>';

export function validate(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data, issues: [] };
  const issues = result.error.issues.slice(0, MAX_ISSUES).map((i) => `${formatPath(i.path)}: ${i.message}`);
  return { ok: false, issues };
}
