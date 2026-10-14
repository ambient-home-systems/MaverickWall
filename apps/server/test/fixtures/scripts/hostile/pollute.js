export default async function run() {
  const seen = [typeof globalThis.leftBehind, typeof {}.polluted].join(',');
  globalThis.leftBehind = 'from an earlier run';
  Object.prototype.polluted = true;
  Array.prototype.push = function () {
    return 0;
  };
  return { panel: { kind: 'text', text: 'seen: ' + seen } };
}
