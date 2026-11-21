const assert = require('node:assert/strict');
/** Retains incomplete TCP frames between reads, including unknown packet types. */
class PacketReader {
  pending = Buffer.alloc(0);

  constructor(onPacket) {
    this.onPacket = onPacket;
  }

  receive(data) {
    this.pending = Buffer.concat([this.pending, data]);
    while (this.pending.length >= 2) {
      const length = this.pending.readUInt16LE(0);
      assert.ok(length > 0, 'protocol packet must include an identifier');
      const frameLength = length + 2;
      if (this.pending.length < frameLength) {
        return;
      }
      const packet = this.pending.subarray(0, frameLength);
      this.pending = this.pending.subarray(frameLength);
      this.onPacket(packet);
    }
  }
}

module.exports = { PacketReader };
