import type { RequestWindbotJoinOptions } from './types';
import { parseRulePrefix } from './parse-rule-prefix';

export const parseWindbotOptions = (name: string): RequestWindbotJoinOptions => {
  const rule = parseRulePrefix(name);
  const options: RequestWindbotJoinOptions = {};
  if (!rule) {
    return options;
  }
  if (/(^|，|,)(SS|SCISSORS)(，|,|$)/.test(rule)) {
    options.hand = 1;
  } else if (/(^|，|,)(ROCK)(，|,|$)/.test(rule)) {
    options.hand = 2;
  } else if (/(^|，|,)(PAPER)(，|,|$)/.test(rule)) {
    options.hand = 3;
  }
  return options;
};
