import { ChatColor, YGOProStocChat } from 'ygopro-msg-encode';
import { Client, I18nService } from '../src/client';
import { YGOProStocChatReplayHint } from '../src/replay';
import { YGOProStocReplay } from 'ygopro-msg-encode';
import { BlockReplay } from '../src/feats/block-replay';
import { Emitter } from '../src/services/emitter';

test('the global replay blocker also suppresses hints without blocking normal chat', async () => {
  const emitter = new Emitter({} as any);
  await new BlockReplay({
    config: { getBoolean: () => true },
    middleware: emitter.middleware.bind(emitter),
  } as any).init();
  const client = { roomName: 'room' } as Client;
  expect(
    await emitter.dispatch(new YGOProStocReplay(), client),
  ).toBeUndefined();
  expect(
    await emitter.dispatch(new YGOProStocChatReplayHint(), client),
  ).toBeUndefined();
  expect(await emitter.dispatch(new YGOProStocChat(), client)).toBeInstanceOf(
    YGOProStocChat,
  );
});

test('replay hints preserve their subclass when copied and use normal chat wire bytes', () => {
  const fields = { msg: 'Sending replay', player_type: ChatColor.BABYBLUE };
  const hint = new YGOProStocChatReplayHint().fromPartial(fields);
  const copied = hint.copy();
  expect(copied).toBeInstanceOf(YGOProStocChatReplayHint);
  expect(copied.toFullPayload()).toEqual(
    new YGOProStocChat().fromPartial(fields).toFullPayload(),
  );
});

test('Client.sendChat preserves the hint subclass through translation and line splitting', async () => {
  const context: any = {
    createLogger: () => ({ debug: jest.fn(), warn: jest.fn() }),
    dispatch: async (event: unknown) => event,
    get: (factory: () => unknown) => {
      if (factory() === I18nService) {
        return {
          translate: async (_locale: string, text: string) =>
            text.replace('#{replay_hint_part1}', 'Sending game '),
        };
      }
      return { getLocale: () => 'en-US' };
    },
  };
  const client = new Client(context);
  client.send = jest.fn();
  await client.sendChat(
    '#{replay_hint_part1}1\n#{replay_hint_part1}2',
    ChatColor.BABYBLUE,
    YGOProStocChatReplayHint,
  );
  const messages = (client.send as jest.Mock).mock.calls.map(
    ([message]) => message,
  );
  expect(messages).toHaveLength(2);
  for (const message of messages) {
    expect(message).toBeInstanceOf(YGOProStocChatReplayHint);
    expect(message.msg).toContain('Sending game ');
    expect(message.msg).not.toContain('#{');
  }
});
