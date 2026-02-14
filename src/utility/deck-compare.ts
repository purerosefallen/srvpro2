import YGOProDeck from 'ygopro-deck-encode';

/**
 * 比较两个卡组是否相等
 * 使用 toUpdateDeckPayload 转换为 buffer 然后比较
 * 这是与 srvpro 一致的比较方法
 */
export function isUpdateDeckPayloadEqual(
  deck1: YGOProDeck,
  deck2: YGOProDeck,
): boolean {
  const uint8Array1 = deck1.toUpdateDeckPayload();
  const uint8Array2 = deck2.toUpdateDeckPayload();

  // 将 Uint8Array 转换为 Buffer 再比较
  const buffer1 = Buffer.from(uint8Array1);
  const buffer2 = Buffer.from(uint8Array2);

  return buffer1.equals(buffer2);
}
