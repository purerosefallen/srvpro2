import { createCipheriv, createHash } from 'node:crypto';
import YGOProDeck from 'ygopro-deck-encode';

const UINT32_RANGE = 0x1_0000_0000;
const SHUFFLE_KEY_LABEL = 'srvpro2-deck-shuffle';
const KEYSTREAM_CHUNK = Buffer.alloc(1024);

const createSeededRng = (seed: number[]) => {
  const seedBytes = Buffer.alloc(seed.length * 4);
  seed.forEach((value, i) => seedBytes.writeUInt32LE(value >>> 0, i * 4));
  const key = createHash('sha256')
    .update(SHUFFLE_KEY_LABEL)
    .update(seedBytes)
    .digest();
  const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16));
  let keystream = cipher.update(KEYSTREAM_CHUNK);
  let offset = 0;
  return () => {
    if (offset === keystream.length) {
      keystream = cipher.update(KEYSTREAM_CHUNK);
      offset = 0;
    }
    const value = keystream.readUInt32LE(offset);
    offset += 4;
    return value;
  };
};

const nextInt = (nextU32: () => number, maxExclusive: number) => {
  if (maxExclusive <= 1) {
    return 0;
  }
  const bound = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  let value = nextU32();
  while (value >= bound) {
    value = nextU32();
  }
  return value % maxExclusive;
};

const shuffleMainDeck = (main: number[], nextU32: () => number) => {
  for (let i = main.length - 1; i > 0; --i) {
    const j = nextInt(nextU32, i + 1);
    [main[i], main[j]] = [main[j], main[i]];
  }
};

export const shuffleDecksBySeed = (decks: YGOProDeck[], seed: number[]) => {
  const nextU32 = createSeededRng(seed);
  return decks.map((deck) => {
    const cloned = new YGOProDeck(deck);
    shuffleMainDeck(cloned.main, nextU32);
    return cloned;
  });
};
