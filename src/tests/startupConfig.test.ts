import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript } from './helpers.js';

/** The real server entry point must refuse to start on unsafe production configuration (no database needed). */
const server = path.resolve(process.cwd(), 'src/server.ts');
// Start from a clean env so the developer's own .env / shell can neither mask nor cause a failure.
const base = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', PORT: '0', SCHEDULER_ENABLED: 'false', HRMS_SKIP_DOTENV: '1' } as NodeJS.ProcessEnv;
const run = (env: Record<string, string>) => runNodeScript(server, [], { ...base, ...env }, 20_000);

describe('startup refuses unsafe configuration', () => {
  test('no JWT_SECRET', async () => {
    const r = await run({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/x' });
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /JWT_SECRET must be set/);
  });
  test('short JWT_SECRET', async () => {
    const r = await run({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/x', JWT_SECRET: 'too-short' });
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /at least 32 characters/);
  });
  test('production without an explicit MONGODB_URI never falls back to localhost', async () => {
    const r = await run({ NODE_ENV: 'production', JWT_SECRET: 'k3J9xQ2vL8mZ5tR7wY1nB4cD6fG0hA3sP9uE2iO5' });
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /MONGODB_URI must be set in production/);
  });
  test('production with a placeholder-looking JWT_SECRET', async () => {
    const r = await run({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/x', JWT_SECRET: 'a'.repeat(40) });
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /placeholder/);
  });
});
