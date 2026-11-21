/** Preserve a reverse proxy's base path when appending service routes. */
export function serviceEndpoint(value: string, transport: 'http' | 'ws') {
  const url = new URL(value);
  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid service endpoint');
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  url.protocol = transport + (secure ? 's:' : ':');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}
