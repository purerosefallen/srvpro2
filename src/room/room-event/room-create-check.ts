import { HostInfo } from 'ygopro-msg-encode';
import { ValueContainer } from '../../utility/value-container';

export class RoomCreateCheck extends ValueContainer<string> {
  constructor(
    public hostinfo: HostInfo,
    public roomName = '',
  ) {
    super('');
  }
}
