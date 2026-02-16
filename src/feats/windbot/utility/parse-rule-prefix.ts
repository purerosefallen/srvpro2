export const parseRulePrefix = (name: string) => {
  const rulePrefix = name.match(/(.+)#/);
  if (!rulePrefix) {
    return '';
  }
  return rulePrefix[1].toUpperCase();
};
