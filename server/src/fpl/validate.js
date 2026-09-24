// Minimal structural validation for data crossing the FPL API boundary.
// Schemas describe only the fields this app relies on; unknown fields pass
// through untouched so additive upstream changes do not break the client.

const MAX_ISSUES = 20;

const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function primitive(name, check) {
  return (value, path, issues) => {
    if (!check(value)) issues.push(`${path || '<root>'}: expected ${name}, got ${describe(value)}`);
  };
}

export const t = {
  int: () => primitive('integer', Number.isInteger),
  number: () => primitive('number', (v) => typeof v === 'number' && Number.isFinite(v)),
  string: () => primitive('string', (v) => typeof v === 'string'),
  bool: () => primitive('boolean', (v) => typeof v === 'boolean'),
  nullable: (schema) => (value, path, issues) => {
    if (value !== null) schema(value, path, issues);
  },
  array: (item) => (value, path, issues) => {
    if (!Array.isArray(value)) {
      issues.push(`${path || '<root>'}: expected array, got ${describe(value)}`);
      return;
    }
    for (let i = 0; i < value.length && issues.length < MAX_ISSUES; i++) {
      item(value[i], `${path}[${i}]`, issues);
    }
  },
  object: (shape) => (value, path, issues) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`${path || '<root>'}: expected object, got ${describe(value)}`);
      return;
    }
    for (const [key, schema] of Object.entries(shape)) {
      if (issues.length >= MAX_ISSUES) return;
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in value)) {
        issues.push(`${childPath}: missing`);
        continue;
      }
      schema(value[key], childPath, issues);
    }
  },
};

// Returns an array of issue strings (empty when valid).
export function validate(schema, value) {
  const issues = [];
  schema(value, '', issues);
  return issues.slice(0, MAX_ISSUES);
}
