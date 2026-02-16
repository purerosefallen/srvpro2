import { Client } from '../../client';
import { Room } from '../../room';
import { ValueContainer } from '../../utility/value-container';

export class CanReconnectCheck extends ValueContainer<boolean> {
  constructor(
    public client: Client,
    public room: Room,
  ) {
    super(true);
  }

  get canReconnect() {
    return this.value;
  }

  no() {
    return this.use(false);
  }
}
