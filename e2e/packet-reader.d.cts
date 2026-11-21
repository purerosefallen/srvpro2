export class PacketReader {
  constructor(onPacket: (packet: Buffer) => void);
  receive(data: Buffer): void;
}
