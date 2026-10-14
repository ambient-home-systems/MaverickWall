export default async function run() {
  return { panel: { kind: 'text', text: 'x'.repeat(4 * 1024 * 1024) } };
}
