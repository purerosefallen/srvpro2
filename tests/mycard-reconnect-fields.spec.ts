import { Client } from '../src/client';
import '../src/feats/mycard';
import { getSpecificFields } from '../src/utility/metadata';

describe('mycard reconnect fields', () => {
  test('registers mycard client fields for reconnect import', () => {
    const fields = getSpecificFields('clientRoomField', Client.prototype).map(
      ({ key }) => key,
    );

    expect(fields).toEqual(
      expect.arrayContaining([
        'mycardBan',
        'mycardArenaJoinTime',
        'mycardArenaQuitFree',
      ]),
    );
  });
});
