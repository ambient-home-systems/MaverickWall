export default async function run() {
  const evil = /(a+)+$/;
  return { panel: { kind: 'text', text: String(evil.test('a'.repeat(48) + '!')) } };
}
