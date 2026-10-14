export default async function run(ctx) {
  let reached = 'nothing';
  try {
    await ctx.fetch('https://not-declared.example/');
  } catch (error) {
    const outside = error.constructor.constructor('return this')();
    if (typeof outside.process !== 'undefined') reached = 'process';
    reached += ' / ' + Object.getPrototypeOf(error).constructor.name;
  }
  return { panel: { kind: 'text', text: 'reached: ' + reached } };
}
