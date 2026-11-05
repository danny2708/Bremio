export class Stack {
  #items = [];

  push(value) {
    this.#items.push(value);
  }

  pop() {
    if (this.#items.length === 0) throw new Error("pop from empty stack");
    return this.#items.pop();
  }

  peek() {
    return this.#items[this.#items.length - 1];
  }

  get size() {
    return Math.max(0, this.#items.length - 1);
  }
}
