// Natural-key collections derive _id from their component fields and reject a
// document whose _id disagrees (architecture v0.3 §4). Builders live in
// db/ids.js so the checker and writer can never disagree.
export function deterministicId(schema, buildId) {
  schema.pre('validate', async function checkDeterministicId() {
    const expected = buildId(this);
    if (this._id == null) this._id = expected;
    if (this._id !== expected) throw new Error(`_id ${this._id} != ${expected}`);
  });
}
