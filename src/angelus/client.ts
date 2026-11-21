import WebSocket from 'ws';
import * as P from 'ygopro-msg-encode';

type Reply = P.YGOProAngelusStocBase;
type Pending = {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class AngelusClient {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  private retiring = false;
  onFailure?: (error: Error) => void;
  onMessage?: (message: P.YGOProAngelusCoreMessage) => void;

  private constructor(private socket: WebSocket) {
    socket.on('error', (error) => this.fail(error));
    socket.once('close', () =>
      this.fail(new Error('Angelus connection closed')),
    );
    socket.on('message', (bytes: Buffer, binary) => {
      try {
        if (!binary) throw new Error('Expected an Angelus binary frame');
        const reply = P.YGOProAngelusStoc.getInstanceFromPayload(bytes);
        if (reply instanceof P.YGOProAngelusCoreMessage) {
          this.onMessage?.(reply);
          return;
        }
        const request = reply && this.pending.get(reply.requestId);
        if (!request) throw new Error('Unexpected Angelus reply');
        if (reply instanceof P.YGOProAngelusError) {
          throw new Error('Angelus error ' + reply.code + ': ' + reply.message);
        }
        this.pending.delete(reply.requestId);
        clearTimeout(request.timer);
        request.resolve(reply);
      } catch (error) {
        this.fail(error as Error);
      }
    });
  }

  static async open(
    url: URL,
    start: P.YGOProAngelusStart,
    onMessage?: AngelusClient['onMessage'],
    token?: string,
  ) {
    const socket = new WebSocket(url, 'ygoangelus.v1', {
      handshakeTimeout: 10000,
      headers: token ? { 'x-server-token': token } : undefined,
    });
    const client = new AngelusClient(socket);
    client.onMessage = onMessage;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('open', () => {
          socket.off('error', reject);
          resolve();
        });
      });
      await client.call(start, P.YGOProAngelusStartOk);
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  get active() {
    return !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.socket.terminate();
    if (!this.retiring) this.onFailure?.(error);
    this.onMessage = undefined;
    this.onFailure = undefined;
  }

  close() {
    this.retiring = true;
    this.fail(new Error('Angelus connection retired'));
  }

  private call<T extends Reply>(
    command: P.YGOProAngelusCtosBase,
    expected: new () => T,
    timeout = 10000,
  ): Promise<T> {
    if (!this.active) return Promise.reject(new Error('Angelus is closed'));
    const id = ++this.nextId;
    command.requestId = id;
    const bytes = command.toFullPayload();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new Error('Angelus request timed out: ' + command.constructor.name),
          ),
        timeout,
      );
      this.pending.set(id, {
        timer,
        reject,
        resolve: (reply) => {
          if (reply instanceof expected) resolve(reply);
          else {
            const error = new Error(
              'Unexpected response to ' + command.constructor.name,
            );
            reject(error);
            this.fail(error);
          }
        },
      });
      this.socket.send(bytes, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async *advance() {
    while (true) {
      const batch = await this.call(
        new P.YGOProAngelusProcess(),
        P.YGOProAngelusProcessResult,
        60000,
      );
      const messages = batch.decodeMessages();
      for (const [index, message] of messages.entries()) {
        yield { message, raw: batch.messages[index] };
      }
      if (batch.status !== 0) return;
    }
  }

  async setResponse(response: Uint8Array) {
    await this.call(
      new P.YGOProAngelusResponse().fromPartial({ response }),
      P.YGOProAngelusResponseOk,
    );
  }

  async queryFieldCount(
    query: Pick<P.YGOProAngelusQueryFieldCount, 'player' | 'location'>,
  ) {
    return (
      await this.call(
        new P.YGOProAngelusQueryFieldCount().fromPartial(query),
        P.YGOProAngelusQueryFieldCountResult,
      )
    ).count;
  }

  async queryFieldInfo() {
    const { raw } = await this.call(
      new P.YGOProAngelusQueryFieldInfo(),
      P.YGOProAngelusQueryFieldInfoResult,
    );
    return { field: new P.YGOProMsgReloadField().fromPayload(raw) };
  }

  async queryCard(
    query: Pick<
      P.YGOProAngelusQueryCard,
      'player' | 'location' | 'sequence' | 'queryFlag' | 'useCache'
    >,
  ) {
    const { raw } = await this.call(
      new P.YGOProAngelusQueryCard().fromPartial(query),
      P.YGOProAngelusQueryCardResult,
    );
    if (!raw.length) return { card: null };
    const { card, length } = P.parseCardQueryChunk(raw);
    if (length !== raw.length)
      throw new Error('Invalid Angelus card query length');
    return { card: card.empty ? null : card };
  }

  async queryFieldCard(
    query: Pick<
      P.YGOProAngelusQueryFieldCard,
      'player' | 'location' | 'queryFlag' | 'useCache'
    >,
  ) {
    const { raw } = await this.call(
      new P.YGOProAngelusQueryFieldCard().fromPartial(query),
      P.YGOProAngelusQueryFieldCardResult,
    );
    const cards: P.CardQuery[] = [];
    for (let offset = 0; offset < raw.length; ) {
      const chunk = P.parseCardQueryChunk(raw, offset);
      cards.push(chunk.card);
      offset += chunk.length;
    }
    return { cards };
  }

  async finish() {
    this.retiring = true;
    try {
      return (
        await this.call(new P.YGOProAngelusFinish(), P.YGOProAngelusFinishOk)
      ).decodeRegistry();
    } finally {
      this.close();
    }
  }
}
