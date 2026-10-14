export default async function run(ctx) {
  const outside = ctx.fetch.constructor.constructor('return this')();
  const reach = ['process', 'require', 'module', 'Buffer', 'std', 'os', '__mwFetch', '__mwLocal', '__mwContext'];
  const found = reach.filter((name) => typeof outside[name] !== 'undefined');
  return { panel: { kind: 'text', text: 'reached: ' + (found.length === 0 ? 'nothing' : found.join(',')) } };
}
