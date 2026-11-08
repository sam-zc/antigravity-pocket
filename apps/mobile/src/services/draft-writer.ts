type Write = (text: string, command: string | null) => Promise<void>;
type Pending = {
  text: string;
  command: string | null;
  edit: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};
/** Replace only unsaved edits. Command records and clears are ordered durability barriers. */
export class DraftWriter {
  private queue: Pending[] = [];
  private running = false;
  constructor(private write: Write) {}
  edit(text: string) {
    return this.enqueue(text, null, true);
  }
  save(text: string, command: string | null = null) {
    return this.enqueue(text, command, false);
  }
  private enqueue(text: string, command: string | null, edit: boolean) {
    const last = this.queue.at(-1);
    if (edit && last?.edit) {
      last.text = text;
      return last.promise;
    }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.queue.push({ text, command, edit, promise, resolve, reject });
    if (!this.running) void this.drain();
    return promise;
  }
  private async drain() {
    this.running = true;
    let item: Pending | undefined;
    while ((item = this.queue.shift())) {
      try {
        await this.write(item.text, item.command);
        item.resolve();
      } catch (error) {
        item.reject(error);
      }
    }
    this.running = false;
  }
}
