import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSpoolDir } from '../../src/bus/safe-fs.mjs';
import { makeTmpDir } from '../helpers/fixtures.mjs';

test('should refuse a spool dir under a world-writable intermediate ancestor without sticky bit', (t) => {
  const base = makeTmpDir(t);
  const open = join(base, 'open');
  mkdirSync(open);
  chmodSync(open, 0o777);
  t.after(() => { try { chmodSync(open, 0o700); } catch { /* removed */ } });
  const project = join(open, 'project');
  mkdirSync(project, { mode: 0o755 });
  assert.throws(() => ensureSpoolDir(join(project, 'spool')), { code: 'spool_parent_world_writable' });
});

test('should accept a spool dir under a sticky world-writable intermediate ancestor', (t) => {
  const base = makeTmpDir(t);
  const sticky = join(base, 'sticky');
  mkdirSync(sticky);
  chmodSync(sticky, 0o1777);
  t.after(() => { try { chmodSync(sticky, 0o700); } catch { /* removed */ } });
  const project = join(sticky, 'project');
  mkdirSync(project, { mode: 0o755 });
  assert.doesNotThrow(() => ensureSpoolDir(join(project, 'spool')));
});

test('should still refuse a world-writable immediate parent without sticky bit', (t) => {
  const parent = join(makeTmpDir(t), 'open');
  mkdirSync(parent);
  chmodSync(parent, 0o777);
  t.after(() => { try { chmodSync(parent, 0o700); } catch { /* removed */ } });
  assert.throws(() => ensureSpoolDir(join(parent, 'spool')), { code: 'spool_parent_world_writable' });
});
