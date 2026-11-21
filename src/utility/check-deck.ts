import YGOProDeck from 'ygopro-deck-encode';

export const checkChangeSide = (
  oldDeck: YGOProDeck,
  newDeck: YGOProDeck,
): boolean => {
  // Helper function to count all cards in a deck
  const countCards = (deck: YGOProDeck): Map<number, number> => {
    const count = new Map<number, number>();
    for (const code of [...deck.main, ...deck.extra, ...deck.side]) {
      count.set(code, (count.get(code) || 0) + 1);
    }
    return count;
  };

  // Check deck sizes remain the same
  if (
    (['main', 'extra', 'side'] as const).some(
      (part) => newDeck[part].length !== oldDeck[part].length,
    )
  ) {
    return false;
  }

  // Count cards in both decks
  const oldCount = countCards(oldDeck);
  const newCount = countCards(newDeck);

  // Collect all unique card codes
  const allCodes = new Set<number>([...oldCount.keys(), ...newCount.keys()]);

  // Check that each card count is the same
  for (const code of allCodes) {
    if ((oldCount.get(code) || 0) !== (newCount.get(code) || 0)) {
      return false;
    }
  }

  return true;
};
