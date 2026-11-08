/** Local persistence failure is distinct from transport loss; do not retry sends or display retired content. */
export class StorageError extends Error {}
