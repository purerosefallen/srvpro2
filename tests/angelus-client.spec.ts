import { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import * as P from 'ygopro-msg-encode';
import { AngelusClient } from '../src/angelus';

const start = () =>
  new P.YGOProAngelusStart().fromPartial({
    seed: [1, 2, 3, 4, 5, 6, 7, 8],
    duelRule: 5,
    flags: 0,
    startLp: 8000,
    startHand: 5,
    drawCount: 1,
    decks: [[1], [2]],
    registry: new Uint8Array(),
  });
async function server(
  handler: (ws: WebSocket, request: P.YGOProAngelusCtosBase) => void,
) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const headers: string[] = [];
  wss.on('connection', (ws, req) => {
    headers.push(req.headers['x-server-token'] as string);
    expect(req.url).toBe('/duel');
    expect(ws.protocol).toBe('ygoangelus.v1');
    ws.on('message', (raw: Buffer) =>
      handler(ws, P.YGOProAngelusCtos.getInstanceFromPayload(raw)),
    );
  });
  return {
    headers,
    url: new URL(
      'ws://127.0.0.1:' + (wss.address() as AddressInfo).port + '/duel',
    ),
    stop: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
function send(
  ws: WebSocket,
  reply: P.YGOProAngelusStocBase,
  request: P.YGOProAngelusCtosBase,
) {
  reply.requestId = request.requestId;
  ws.send(reply.toFullPayload());
}
test.each(['', 'example-token'])(
  'push before START, interleaved queries and FINISH registry (%j)',
  async (token) => {
    let first: P.YGOProAngelusCtosBase;
    const peer = await server((ws, req) => {
      if (req instanceof P.YGOProAngelusStart) {
        ws.send(
          new P.YGOProAngelusCoreMessage()
            .fromPartial({ requestId: 0, type: 0, message: 'preload' })
            .toFullPayload(),
        );
        send(ws, new P.YGOProAngelusStartOk(), req);
      } else if (req instanceof P.YGOProAngelusQueryFieldCount) {
        if (!first) first = req;
        else {
          send(
            ws,
            new P.YGOProAngelusQueryFieldCountResult().fromPartial({
              count: 2,
            }),
            req,
          );
          send(
            ws,
            new P.YGOProAngelusQueryFieldCountResult().fromPartial({
              count: 1,
            }),
            first,
          );
        }
      } else
        send(
          ws,
          new P.YGOProAngelusFinishOk().setRegistry({ 名前: '値' }),
          req,
        );
    });
    try {
      const push = jest.fn(),
        failure = jest.fn();
      const duel = await AngelusClient.open(peer.url, start(), push, token);
      duel.onFailure = failure;
      expect(peer.headers).toEqual([token || undefined]);
      expect(push.mock.calls[0][0].message).toBe('preload');
      expect(
        await Promise.all(
          [0, 1].map((player) => duel.queryFieldCount({ player, location: 1 })),
        ),
      ).toEqual([1, 2]);
      expect(await duel.finish()).toEqual({ 名前: '値' });
      expect(failure).not.toHaveBeenCalled();
    } finally {
      await peer.stop();
    }
  },
);
test.each(['disconnect', 'short', 'wrong reply', 'server error', 'timeout'])(
  'fails every pending request once on %s',
  async (fault) => {
    let n = 0;
    const peer = await server((ws, req) => {
      if (req instanceof P.YGOProAngelusStart)
        return send(ws, new P.YGOProAngelusStartOk(), req);
      if (++n !== 2) return;
      if (fault === 'disconnect') ws.terminate();
      if (fault === 'short') ws.send(Buffer.alloc(2));
      if (fault === 'wrong reply')
        send(ws, new P.YGOProAngelusResponseOk(), req);
      if (fault === 'server error')
        send(
          ws,
          new P.YGOProAngelusError().fromPartial({
            code: 4,
            message: 'timeout',
          }),
          req,
        );
    });
    try {
      const duel = await AngelusClient.open(peer.url, start());
      const failure = jest.fn();
      duel.onFailure = failure;
      const requests = [0, 1].map((player) =>
        fault === 'timeout'
          ? (duel as any).call(
              new P.YGOProAngelusQueryFieldInfo(),
              P.YGOProAngelusQueryFieldInfoResult,
              30,
            )
          : duel.queryFieldCount({ player, location: 1 }),
      );
      expect((await Promise.allSettled(requests)).map((r) => r.status)).toEqual(
        ['rejected', 'rejected'],
      );
      expect(failure).toHaveBeenCalledTimes(1);
    } finally {
      await peer.stop();
    }
  },
);

test('advances empty and multi-message batches and treats RETRY as a new choice', async () => {
  const turn = new P.YGOProMsgNewTurn().fromPartial({ player: 0 });
  const phase = new P.YGOProMsgNewPhase().fromPartial({ phase: 4 });
  const retry = new P.YGOProMsgRetry();
  const batches = [[], [turn, phase], [retry]];
  const peer = await server((ws, request) => {
    if (request instanceof P.YGOProAngelusStart)
      return send(ws, new P.YGOProAngelusStartOk(), request);
    const messages = batches.shift();
    const raw = Buffer.concat(
      messages.map((message) => Buffer.from(message.toPayload())),
    );
    send(
      ws,
      new P.YGOProAngelusProcessResult().fromOcgcorePayload(raw),
      request,
    );
  });
  try {
    const duel = await AngelusClient.open(peer.url, start());
    const received = [];
    for await (const item of duel.advance())
      received.push(Buffer.from(item.raw));
    expect(received).toEqual(
      [turn, phase, retry].map((message) => Buffer.from(message.toPayload())),
    );
    expect(duel.active).toBe(true);
    duel.close();
  } finally {
    await peer.stop();
  }
});
