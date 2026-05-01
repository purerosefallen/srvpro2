import { randomBytes } from 'node:crypto';

export const generateSeed = () => {
  const buffer = randomBytes(32);
  const res: number[] = [];
  for (let i = 0; i < 8; i++) {
    res.push(buffer.readUInt32LE(i * 4));
  }
  return res;
};
