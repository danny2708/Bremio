export class Stack {
  #items = [];

  push(value) {
    this.#items.push(value);
  }

  pop() {
    return this.#items.pop();
  }

  peek() {
    return this.#items[this.#items.length - 1];
  }

  get size() {
    return this.#items.length;
  }
}
