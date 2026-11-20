import { PacketReader } from '../e2e/mycard-protocol-client';

test('spectator client handles split TCP headers, split bodies and coalesced packets', () => {
  const first = Buffer.from([3, 0, 0x13, 7, 0]);
  const second = Buffer.from([2, 0, 0xfe, 9]);
  const received: Buffer[] = [];
  const reader = new PacketReader((packet) => received.push(packet));
  reader.receive(first.subarray(0, 1));
  reader.receive(first.subarray(1, 4));
  expect(received).toHaveLength(0);
  reader.receive(Buffer.concat([first.subarray(4), second]));
  expect(received).toEqual([first, second]);
});
