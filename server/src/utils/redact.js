// Log redaction (Step 12): strips credentials and tokens from strings before
// they reach stdout/stderr (Render logs). Applied to error messages and stacks;
// request bodies, cookies and FPL responses are never logged in the first place.

const RULES = [
  [/(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi, '$1***@'], // URI credentials
  [/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, '[bcrypt]'], // password hashes
  [/\beyJ[\w-]*\.[\w-]+\.[\w-]+/g, '[jwt]'], // JWTs (header starts with {" → eyJ)
  [/\b(Bearer)\s+[\w.~+/=-]+/gi, '$1 [redacted]'],
  [/\b((?:fpl_admin|[\w-]*token|[\w-]*secret|password)["']?\s*[=:]\s*["']?)[^\s"';,&]+/gi, '$1[redacted]'],
];

export function redact(value) {
  let s = typeof value === 'string' ? value : String(value);
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s;
}

/** A loggable summary of an error: name, code, message and stack, redacted. */
export function redactError(err) {
  if (!(err instanceof Error)) return redact(err);
  const head = `${err.name}${err.code !== undefined ? ` [${err.code}]` : ''}: ${err.message}`;
  const stack = err.stack ? err.stack.split('\n').slice(1).join('\n') : '';
  return redact(stack ? `${head}\n${stack}` : head);
}
