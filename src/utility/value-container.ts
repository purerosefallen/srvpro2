export class ValueContainer<T> {
  constructor(public value: T) {}

  use(value: T) {
    this.value = value;
    return this;
  }
}
