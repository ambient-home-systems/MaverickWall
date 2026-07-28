import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The engine must be timezone-agnostic. Pinning the process clock to a zone
    // far from UTC, and from every zone under test, makes any accidental
    // reliance on the host's local time fail loudly instead of passing on a CI
    // box that happens to run UTC.
    env: { TZ: 'Pacific/Chatham' },
  },
});
