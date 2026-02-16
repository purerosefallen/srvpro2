export function pickRandom<T>(items: T[]) {
  if (!items.length) {
    return undefined;
  }
  const index = Math.floor(Math.random() * items.length);
  return items[index];
}
