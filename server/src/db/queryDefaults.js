// Default maxTimeMS for every query (architecture v0.3 §11), applied per schema
// by models/shared.js#defineModel so it holds regardless of import order.

export const DEFAULT_MAX_TIME_MS = 5000;

const QUERY_OPS = ['find', 'findOne', 'countDocuments', 'distinct', 'findOneAndUpdate', 'findOneAndReplace',
  'findOneAndDelete', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany'];

export function defaultMaxTime(schema) {
  schema.pre(QUERY_OPS, async function applyMaxTime() {
    if (this.getOptions().maxTimeMS === undefined) this.maxTimeMS(DEFAULT_MAX_TIME_MS);
  });
  schema.pre('aggregate', async function applyAggregateMaxTime() {
    if (this.options.maxTimeMS === undefined) this.option({ maxTimeMS: DEFAULT_MAX_TIME_MS });
  });
}
