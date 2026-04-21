import { YGOProCtosJoinGame } from 'ygopro-msg-encode';
import { MycardJoinHandler, MycardService } from '../src/feats/mycard';

function makeCtx(service: Partial<MycardService>) {
  const middlewares: any[] = [];
  return {
    middlewares,
    get: () => service,
    middleware: (_cls: unknown, handler: unknown) => {
      middlewares.push(handler);
      return undefined;
    },
  } as any;
}

describe('MycardJoinHandler', () => {
  test('passes through when disabled or AI# pass', async () => {
    const disabledCtx = makeCtx({ enabled: false });
    const disabledHandler = new MycardJoinHandler(disabledCtx);
    await disabledHandler.init();
    const nextDisabled = jest.fn();
    await disabledCtx.middlewares[0](
      new YGOProCtosJoinGame().fromPartial({ pass: 'anything' }),
      {},
      nextDisabled,
    );
    expect(nextDisabled).toHaveBeenCalled();

    const enabledCtx = makeCtx({ enabled: true });
    const enabledHandler = new MycardJoinHandler(enabledCtx);
    await enabledHandler.init();
    const nextAi = jest.fn();
    await enabledCtx.middlewares[0](
      new YGOProCtosJoinGame().fromPartial({ pass: 'AI#bot' }),
      {},
      nextAi,
    );
    expect(nextAi).toHaveBeenCalled();
  });

  test('delegates non-empty non-AI passes to MycardService', async () => {
    const handleJoinPass = jest.fn(async () => true);
    const ctx = makeCtx({
      enabled: true,
      handleJoinPass,
    } as any);
    const handler = new MycardJoinHandler(ctx);
    await handler.init();
    const next = jest.fn();
    const msg = new YGOProCtosJoinGame().fromPartial({ pass: '  pass  ' });

    await ctx.middlewares[0](msg, { name: 'player' }, next);

    expect(handleJoinPass).toHaveBeenCalledWith('pass', { name: 'player' });
    expect(next).not.toHaveBeenCalled();
  });
});

