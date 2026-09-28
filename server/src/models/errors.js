// Raised by the append-only plugin (architecture v0.3 §7, layer 2).
export class ImmutableCollectionError extends Error {
  constructor(model, op) {
    super(`${model} is append-only: ${op} is not allowed`);
    this.name = 'ImmutableCollectionError';
    this.model = model;
    this.op = op;
  }
}
