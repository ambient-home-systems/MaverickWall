function down(depth) {
  return down(depth + 1) + 1;
}
export default async function run() {
  return { panel: { kind: 'text', text: String(down(0)) } };
}
