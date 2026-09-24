// Location named by architecture v0.3 §14. The implementation lives in
// ../utils/canonical.js so the pure analytics layer can use it without
// importing from db/ (forbidden by the boundary test).
export { canonicalize, canonicalJson, sha256, contentHash } from '../utils/canonical.js';
