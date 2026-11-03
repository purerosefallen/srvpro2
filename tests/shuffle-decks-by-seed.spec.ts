import YGOProDeck from 'ygopro-deck-encode';
import { shuffleDecksBySeed } from '../src/utility/shuffle-decks-by-seed';

const CARDS = Array.from({ length: 40 }, (_, i) => i + 1);

const createDeck = (main: number[]) =>
  new YGOProDeck({ main: [...main], extra: [], side: [] });

const shuffleCards = (seed: number[]) =>
  shuffleDecksBySeed([createDeck(CARDS)], seed)[0].main;

describe('shuffleDecksBySeed', () => {
  test('keeps the cards and leaves the input decks alone', () => {
    const deck = createDeck(CARDS);

    const [shuffled] = shuffleDecksBySeed([deck], [1, 2, 3, 4, 5, 6, 7, 8]);

    expect(shuffled).not.toBe(deck);
    expect(deck.main).toEqual(CARDS);
    expect([...shuffled.main].sort((a, b) => a - b)).toEqual(CARDS);
  });

  test('gives the same order for the same seed', () => {
    const seed = [1, 2, 3, 4, 5, 6, 7, 8];

    expect(shuffleCards(seed)).toEqual(shuffleCards(seed));
  });

  test.each([
    [
      [1, 2, 3, 4, 5, 6, 7, 8],
      [1, 2, 3, 4, 5, 6, 9, 23392070],
    ],
    [
      [1, 2, 3, 4, 5, 6, 7, 8],
      [1, 2, 3, 4, 5, 6, 7, 9],
    ],
  ])('gives different orders for seeds %j and %j', (seedA, seedB) => {
    expect(shuffleCards(seedA)).not.toEqual(shuffleCards(seedB));
  });

  test('shuffles each deck on its own', () => {
    const [first, second] = shuffleDecksBySeed(
      [createDeck(CARDS), createDeck(CARDS)],
      [1, 2, 3, 4, 5, 6, 7, 8],
    );

    expect(first.main).not.toEqual(second.main);
  });

  test('reaches every order about evenly', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 6000; i++) {
      const [{ main }] = shuffleDecksBySeed(
        [createDeck([1, 2, 3])],
        [i, 2, 3, 4, 5, 6, 7, 8],
      );
      const order = main.join();
      counts.set(order, (counts.get(order) || 0) + 1);
    }

    expect(counts.size).toBe(6);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });
});
