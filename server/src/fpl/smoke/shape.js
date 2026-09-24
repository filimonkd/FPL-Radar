// Observed-shape recording for the smoke test (architecture v0.2 §11).
// A shape is a flat map of key paths ("events[].deadline_time") to what was
// seen across every sampled response: types, nullability, how often the key
// was present, and array length ranges.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function walk(value, path, acc) {
  const node = (acc[path] ??= { types: [], nullSeen: false, seen: 0 });
  node.seen += 1;
  const t = typeOf(value);
  if (t === 'null') node.nullSeen = true;
  else if (!node.types.includes(t)) node.types.push(t);

  if (t === 'array') {
    node.length = node.length
      ? { min: Math.min(node.length.min, value.length), max: Math.max(node.length.max, value.length) }
      : { min: value.length, max: value.length };
    for (const item of value) walk(item, `${path}[]`, acc);
  } else if (t === 'object') {
    node.objects = (node.objects ?? 0) + 1;
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, acc);
  }
}

// Builds a shape from one or more response bodies of the same endpoint.
export function deriveShape(values) {
  const acc = {};
  for (const v of values) walk(v, '', acc);
  const paths = {};
  for (const path of Object.keys(acc).sort()) {
    const n = acc[path];
    const parentPath = parentOf(path);
    const parent = parentPath === null ? null : acc[parentPath];
    // A key is optional when some parent objects lacked it.
    const parentObjects = parent ? (path.endsWith('[]') ? null : (parent.objects ?? 0)) : null;
    paths[path || '<root>'] = {
      types: n.types.sort(),
      nullable: n.nullSeen,
      ...(parentObjects !== null && n.seen < parentObjects ? { optional: true } : {}),
      ...(n.length ? { length: n.length } : {}),
    };
  }
  return { samples: values.length, paths };
}

function parentOf(path) {
  if (path === '') return null;
  if (path.endsWith('[]')) return path.slice(0, -2);
  const i = path.lastIndexOf('.');
  return i === -1 ? '' : path.slice(0, i);
}

// Compares two shapes: added / removed paths and paths whose types changed.
export function diffShapes(baseline, current) {
  const b = baseline?.paths ?? {};
  const c = current.paths;
  const added = Object.keys(c).filter((p) => !(p in b));
  const removed = Object.keys(b).filter((p) => !(p in c));
  const retyped = Object.keys(c)
    .filter((p) => p in b && (b[p].types.join('|') !== c[p].types.join('|') || b[p].nullable !== c[p].nullable))
    .map((p) => ({ path: p, from: describe(b[p]), to: describe(c[p]) }));
  return { added, removed, retyped };
}

export const describe = (node) => `${node.types.join('|') || 'null'}${node.nullable ? ' (nullable)' : ''}`;

export const nullablePaths = (shape) =>
  Object.entries(shape.paths)
    .filter(([, n]) => n.nullable)
    .map(([p, n]) => `${p}: ${describe(n)}`);
