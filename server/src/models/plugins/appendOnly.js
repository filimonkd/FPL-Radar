import { ImmutableCollectionError } from '../errors.js';

// Layer 2 of the append-only guarantee (architecture v0.3 §7): every
// update/replace/delete path through Mongoose throws, re-saving an existing
// document throws, and every field is immutable. Mongoose 9: async hooks that
// throw to reject.
const BLOCKED = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne',
  'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'];

export function appendOnly(schema) {
  for (const op of BLOCKED) {
    schema.pre(op, { document: true, query: true }, async function rejectMutation() {
      const model = this.model?.modelName ?? this.constructor.modelName;
      throw new ImmutableCollectionError(model, op);
    });
  }
  schema.pre('bulkWrite', async function rejectBulkWrite(ops) {
    if (ops.some((o) => !('insertOne' in o))) throw new ImmutableCollectionError(this.modelName, 'bulkWrite');
  });
  schema.pre('save', async function rejectResave() {
    if (!this.isNew) throw new ImmutableCollectionError(this.constructor.modelName, 'save');
  });
  schema.eachPath((path, type) => {
    if (path !== '_id') type.options.immutable = true;
  });
}
