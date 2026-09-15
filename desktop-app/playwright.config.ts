import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  // The signed Feed test is intentionally invoked only by its dedicated
  // runner, which starts a real local HTTPS Feed from an already verified
  // Runtime archive. Generic mock E2E must never turn that gate into a
  // fixture-based success.
  testIgnore: [
    ...(process.env.DASCOWORK_PRIMARY_RUNTIME_FEED_E2E === '1'
      ? []
      : ['primary-runtime-feed.e2e.ts']),
    ...(process.env.DASCOWORK_PRIMARY_RUNTIME_SYNTHETIC_FEED_E2E === '1'
      ? []
      : ['primary-runtime-synthetic-feed.e2e.ts'])
  ],
  timeout: 60_000,
  expect: {
    timeout: 20_000
  },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
