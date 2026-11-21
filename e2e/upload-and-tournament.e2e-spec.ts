import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  E2EStack,
  LEGACY_PASSWORD,
  LEGACY_USERNAME,
  OWNER_PASSWORD,
  OWNER_USERNAME,
  fetchJson,
} from './harness';

const deckFixtures = [
  '想成为龍ww的小狗+00000001.ydk',
  '00000002+Alice.ydk',
  '时の雨＋00000003.ydk',
  'Team+A+00000004.ydk',
];

function legacyUrl(stack: E2EStack, path: string) {
  const url = new URL(path, stack.srvproBaseUrl);
  url.searchParams.set('username', LEGACY_USERNAME);
  url.searchParams.set('password', LEGACY_PASSWORD);
  return url.toString();
}

describe('srvpro2 full upload and tournament harness', () => {
  test('preserves Unicode filenames and matches legacy and Challonge decks with WindBot', async () => {
    const stack = new E2EStack();
    await stack.up();
    try {
      const login = await fetchJson<{ token: string }>(
        `${stack.accountsBaseUrl}/signin`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            account: OWNER_USERNAME,
            password: OWNER_PASSWORD,
          }),
        },
      );
      const authHeaders = {
        'content-type': 'application/json',
        'x-user-token': login.token,
      };
      const tournament = await fetchJson<{ data: { id: number } }>(
        `${stack.tabulatorBaseUrl}/api/tournament`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            name: `srvpro2-full-e2e-${Date.now()}`,
            description: 'srvpro2 full compose harness',
            rule: 'SingleElimination',
            ruleSettings: {
              rounds: 2,
              winScore: 3,
              drawScore: 1,
              byeScore: 3,
              hasThirdPlaceMatch: false,
              hasGrandFinalReset: false,
              autoStartNextRound: false,
            },
            visibility: 'Private',
            collaborators: [],
          }),
        },
      );
      const apiKey = await fetchJson<{ data: { key: string } }>(
        `${stack.tabulatorBaseUrl}/api/api-key`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            name: 'srvpro2 full e2e',
            expireAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        },
      );
      stack.configureChallonge(tournament.data.id, apiKey.data.key);
      await stack.startSrvpro(false);
      stack.buildWindbot();

      const ydk = await readFile(
        join(__dirname, 'fixtures/AI_BE2025_2025_10.ydk'),
        'utf-8',
      );
      const uploadForm = new FormData();
      for (const [index, filename] of deckFixtures.entries()) {
        uploadForm.append(
          `deck${index}`,
          new Blob([ydk], { type: 'text/plain' }),
          filename,
        );
      }
      uploadForm.append(
        'empty',
        new Blob([], { type: 'text/plain' }),
        '空卡组+00000005.ydk',
      );
      const upload = await fetchJson<Array<{ file: string; status: string }>>(
        legacyUrl(stack, '/api/upload_decks'),
        { method: 'POST', body: uploadForm },
      );
      for (const filename of deckFixtures) {
        expect(upload).toContainEqual({ file: filename, status: 'OK' });
      }
      expect(upload).toContainEqual({
        file: '空卡组+00000005.ydk',
        status: '卡组不合格',
      });

      const decks = await fetchJson<Array<{ name: string }>>(
        legacyUrl(stack, '/api/get_decks'),
      );
      expect(decks.map((deck) => deck.name)).toEqual(
        expect.arrayContaining(deckFixtures),
      );
      const databaseRows = await stack.querySrvpro<{ name: string }>(
        'SELECT name FROM legacy_deck ORDER BY name',
      );
      expect(databaseRows.map((row) => row.name)).toEqual(
        expect.arrayContaining(deckFixtures),
      );

      await stack.runWindbot(
        '想成为龍ww的小狗',
        'legacy-traditional',
        '成功使用卡组',
      );
      await stack.runWindbot('Alice', 'legacy-right', '成功使用卡组');
      await stack.runWindbot('时の雨', 'legacy-fullwidth', '成功使用卡组');
      await stack.runWindbot(
        'Team',
        'legacy-multi-bad',
        '没有找到您的报名信息',
      );
      await stack.runWindbot(
        'Team+A+00000004',
        'legacy-multi-exact',
        '成功使用卡组',
      );

      await stack.startSrvpro(true);
      const uploadToChallonge = await fetch(
        legacyUrl(stack, '/api/upload_to_challonge'),
      );
      expect(uploadToChallonge.ok).toBe(true);
      expect(await uploadToChallonge.text()).toContain('操作完成');

      const uploadedTournament = await fetchJson<{
        data: { participants: Array<{ name: string; deckbuf?: string }> };
      }>(`${stack.tabulatorBaseUrl}/api/tournament/${tournament.data.id}`, {
        headers: { 'x-user-token': login.token },
      });
      expect(
        uploadedTournament.data.participants.map(
          (participant) => participant.name,
        ),
      ).toEqual(
        expect.arrayContaining(deckFixtures.map((name) => name.slice(0, -4))),
      );
      expect(
        uploadedTournament.data.participants.every(
          (participant) => !!participant.deckbuf,
        ),
      ).toBe(true);

      await fetchJson(
        `${stack.tabulatorBaseUrl}/api/tournament/${tournament.data.id}/start`,
        {
          method: 'POST',
          headers: authHeaders,
          body: '{}',
        },
      );

      await stack.runWindbot('Team', '', '未找到你的参赛信息');
      await stack.runWindbot('想成为龍ww的小狗', '', '成功使用卡组');
      await stack.runWindbot('Alice', '', '成功使用卡组');
      await stack.runWindbot('时の雨', '', '成功使用卡组');
      await stack.runWindbot('Team+A+00000004', '', '成功使用卡组');
    } finally {
      await stack.down();
    }
  });
});
