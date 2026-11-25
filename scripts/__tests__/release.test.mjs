import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkIdentity,
  checkMock,
  checkTag,
  checkVersions,
  main,
  syncCargoLock,
  validateVersion,
  versionUpdates,
} from '../release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureBase = path.join(ROOT, 'target/release-tests');
fs.mkdirSync(fixtureBase, { recursive: true });
const fixtures = [];
const CERTIFICATE = Buffer.from('public test signing certificate');
const PIN = {
  schemaVersion: 1,
  commonName: 'mGit',
  sha1: 'A'.repeat(40),
  sha256: createHash('sha256').update(CERTIFICATE).digest('hex').toUpperCase(),
  notAfter: '2035-01-01T00:00:00Z',
};
after(() => {
  for (const root of fixtures) fs.rmSync(root, { recursive: true, force: true });
});

/** 실제 저장소와 분리된 fixture에서만 Git 이력을 만든다. */
function git(root, ...args) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Release Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'tag.gpgSign=false',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** 현재 매니페스트 구조를 복사해 외부 dependency 보존과 실제 Git 태그 검사를 함께 검증한다. */
function fixture() {
  const root = fs.mkdtempSync(path.join(fixtureBase, 'case-'));
  fixtures.push(root);
  const files = [
    'package.json',
    'Cargo.toml',
    'Cargo.lock',
    'apps/desktop/package.json',
    'apps/desktop/src-tauri/Cargo.toml',
    'apps/desktop/src-tauri/tauri.conf.json',
    'bench/mgit-bench/Cargo.toml',
  ];
  for (const name of fs.readdirSync(path.join(ROOT, 'crates')))
    files.push(`crates/${name}/Cargo.toml`);
  for (const name of ['ipc', 'ui', 'graph-view', 'diff-view', 'merge-editor', 'terminal'])
    files.push(`packages/${name}/package.json`);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  for (const [file, text] of versionUpdates(root, '1.2.3'))
    fs.writeFileSync(path.join(root, file), text);
  fs.mkdirSync(path.join(root, 'packaging'));
  fs.writeFileSync(path.join(root, 'packaging/signing-identity.json'), JSON.stringify(PIN));
  fs.writeFileSync(path.join(root, '.gitignore'), '/target/\n/release/\n/signing/\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

/** OS 도구만 대체하고 Git은 fixture에서 실제로 실행한다. */
function runner(root, overrides = {}) {
  const calls = [];
  const run = (program, args, options = {}) => {
    calls.push({ program, args, options });
    if (program === 'git') return git(root, ...args);
    if (program === 'swift')
      return JSON.stringify({
        ...PIN,
        status: 'ready',
        keychain: '/test/login.keychain-db',
        ...overrides.identity,
      });
    if (program === 'pnpm') {
      assert.equal(options.env.APPLE_SIGNING_IDENTITY, PIN.sha1);
      assert.equal(options.env.APPLE_PASSWORD, undefined);
      assert.equal(options.env.APPLE_API_KEY_PATH, undefined);
      assert.deepEqual(args.slice(-2), ['--', '--locked']);
      const bundle = path.join(root, 'target/aarch64-apple-darwin/release/bundle');
      const app = path.join(bundle, 'macos/mGit.app');
      fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
      fs.mkdirSync(path.join(app, 'Contents/Resources'));
      fs.writeFileSync(path.join(app, 'Contents/Info.plist'), 'fixture plist');
      fs.writeFileSync(path.join(app, 'Contents/MacOS/mgit-desktop'), 'fixture arm64 binary');
      fs.writeFileSync(path.join(app, 'Contents/Resources/data'), 'resource');
      fs.symlinkSync('Resources/data', path.join(app, 'Contents/data'));
      fs.mkdirSync(path.join(bundle, 'dmg'));
      fs.writeFileSync(path.join(bundle, 'dmg/mGit_1.2.3_aarch64.dmg'), 'fixture dmg');
      return '';
    }
    if (program === '/usr/bin/plutil')
      return {
        CFBundleShortVersionString: overrides.version ?? '1.2.3',
        CFBundleVersion: '1.2.3',
        CFBundleIdentifier: 'io.github.motolies.mgit',
        LSMinimumSystemVersion: '15.0',
        CFBundleExecutable: 'mgit-desktop',
      }[args[1]];
    if (program === '/usr/bin/lipo') return overrides.arch ?? 'arm64';
    if (program === '/usr/bin/codesign') {
      if (overrides.signatureFailure && args[0] === '--verify')
        throw new Error('invalid signature');
      if (args[0] === '--display') {
        assert.match(args[1], /^--extract-certificates=/);
        fs.writeFileSync(
          `${args[1].slice('--extract-certificates='.length)}0`,
          overrides.certificate ?? CERTIFICATE,
        );
      }
      return '';
    }
    if (program === '/usr/bin/hdiutil') {
      if (args[0] === 'attach') {
        const mount = args[args.indexOf('-mountpoint') + 1];
        fs.cpSync(
          path.join(root, 'target/aarch64-apple-darwin/release/bundle/macos/mGit.app'),
          path.join(mount, 'mGit.app'),
          { recursive: true, verbatimSymlinks: true },
        );
        fs.symlinkSync(overrides.applications ?? '/Applications', path.join(mount, 'Applications'));
        if (overrides.dmgBinary)
          fs.writeFileSync(
            path.join(mount, 'mGit.app/Contents/MacOS/mgit-desktop'),
            overrides.dmgBinary,
          );
      }
      if (args[0] === 'detach') {
        fs.rmSync(path.join(args[1], 'mGit.app'), { recursive: true });
        fs.unlinkSync(path.join(args[1], 'Applications'));
      }
      return '';
    }
    throw new Error(`Unexpected command: ${program}`);
  };
  return { run, calls };
}

/** 릴리스 명령의 테스트 환경을 만든다. */
function context(root, overrides = {}) {
  const fake = runner(root, overrides);
  return {
    ...fake,
    root,
    platform: 'darwin',
    arch: 'arm64',
    env: { APPLE_PASSWORD: 'must-not-inherit', APPLE_API_KEY_PATH: '/private/key' },
    now: new Date('2026-01-01'),
  };
}

test('strict stable versions reject suffixes and leading zeroes', () => {
  assert.equal(validateVersion('0.1.0'), '0.1.0');
  for (const version of [
    'v1.0.0',
    '01.0.0',
    '1.2',
    '1.2.3-rc.1',
    '1.2.3+build',
    '../1.2.3',
    undefined,
  ])
    assert.throws(() => validateVersion(version));
});

test('prepare changes all app versions and only local Cargo.lock packages', () => {
  const root = fixture();
  const before = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
  const ctx = context(root);
  main(['prepare', '2.3.4'], ctx);
  assert.equal(checkVersions(root), '2.3.4');
  const afterText = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8');
  const external = (text) =>
    text
      .split('[[package]]')
      .filter((block) => /^source\s*=/m.test(block))
      .join('[[package]]');
  assert.equal(external(afterText), external(before));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, 'packages/ui/package.json'))).version,
    '2.3.4',
  );
  assert.match(
    fs.readFileSync(path.join(root, 'crates/mgit-syntax/Cargo.toml'), 'utf8'),
    /version = "2.3.4"/,
  );
});

test('prepare dry-run never writes and actual prepare rejects dirty workspaces', () => {
  const root = fixture();
  const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  fs.writeFileSync(path.join(root, 'untracked'), 'keep');
  assert.equal(main(['prepare', '2.0.0', '--dry-run'], context(root)).dryRun, true);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
  assert.throws(() => main(['prepare', '2.0.0'], context(root)), /clean working tree/);
});

test('lock sync refuses missing or duplicate local crate records', () => {
  assert.throws(() => syncCargoLock('version = 4\n', ['mgit-core'], '1.0.0'), /Missing/);
  assert.throws(
    () => syncCargoLock('[[package]]\nname = "mgit-core"\n', ['mgit-core'], '1.0.0'),
    /Missing/,
  );
  const block = '[[package]]\nname = "mgit-core"\nversion = "0.1.0"\n';
  assert.throws(() => syncCargoLock(block + block, ['mgit-core'], '1.0.0'), /Duplicate/);
});

test('check rejects manifest mismatch', () => {
  const root = fixture();
  const file = path.join(root, 'apps/desktop/package.json');
  const doc = JSON.parse(fs.readFileSync(file));
  doc.version = '9.0.0';
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => checkVersions(root), /mismatch/);
});

test('tag creates one annotated local tag and never pushes', () => {
  const root = fixture();
  const ctx = context(root);
  assert.equal(main(['tag', '--dry-run'], ctx).tag, 'v1.2.3');
  assert.equal(git(root, 'tag'), '');
  main(['tag'], ctx);
  assert.equal(checkTag(ctx.run, root, '1.2.3'), 'v1.2.3');
  assert.equal(git(root, 'cat-file', '-t', 'v1.2.3'), 'tag');
  assert.equal(
    ctx.calls.some((call) => call.args.includes('push')),
    false,
  );
  assert.throws(() => main(['tag'], ctx), /already exists/);
});

test('check rejects missing, lightweight, multiple, and ancestor-only release tags', () => {
  const root = fixture();
  const { run } = runner(root);
  assert.throws(() => checkTag(run, root, '1.2.3'), /exactly one/);
  git(root, 'tag', 'v1.2.3');
  assert.throws(() => checkTag(run, root, '1.2.3'), /annotated/);
  git(root, 'tag', '-d', 'v1.2.3');
  git(root, 'tag', '-a', 'v1.2.3', '-m', 'release');
  git(root, 'tag', '-a', 'v1.2.4', '-m', 'other');
  assert.throws(() => checkTag(run, root, '1.2.3'), /exactly one/);
  git(root, 'tag', '-d', 'v1.2.4');
  git(root, 'commit', '--allow-empty', '-qm', 'after tag');
  assert.throws(() => checkTag(run, root, '1.2.3'), /exactly one/);
});

test('mock values and env-file assignments are rejected without exposing values', () => {
  const root = fixture();
  assert.throws(
    () => checkMock(root, { VITE_MGIT_MOCK: 'secret-marker' }),
    (error) => !error.message.includes('secret-marker'),
  );
  for (const file of ['.env.local', 'apps/desktop/.env.production.local']) {
    fs.writeFileSync(path.join(root, file), '# comment\nexport VITE_MGIT_MOCK_SCENE="repo"\n');
    assert.throws(() => checkMock(root, {}), /environment file/);
    fs.unlinkSync(path.join(root, file));
  }
});

test('identity pin requires matching ready identity and valid expiration', () => {
  const root = fixture();
  assert.equal(checkIdentity(runner(root).run, root).sha256, PIN.sha256);
  assert.throws(
    () => checkIdentity(runner(root, { identity: { status: 'missing' } }).run, root),
    /identity/,
  );
  assert.throws(
    () => checkIdentity(runner(root, { identity: { sha1: 'B'.repeat(40) } }).run, root),
    /identity/,
  );
  assert.throws(() => checkIdentity(runner(root).run, root, new Date('2040-01-01')), /expired/);
});

test('macos dry-run validates without building, tagging, or publishing', () => {
  const root = fixture();
  const ctx = context(root);
  main(['tag'], ctx);
  assert.equal(main(['macos', '--dry-run'], ctx).output, 'release/v1.2.3');
  assert.equal(
    ctx.calls.some((call) => call.program === 'pnpm'),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, 'release')), false);
});

test('successful packaging verifies embedded app, preserves symlinks, and refuses overwrite', () => {
  const root = fixture();
  const ctx = context(root);
  main(['tag'], ctx);
  assert.equal(main(['macos'], ctx).output, 'release/v1.2.3');
  const output = path.join(root, 'release/v1.2.3');
  assert.equal(fs.readlinkSync(path.join(output, 'mGit.app/Contents/data')), 'Resources/data');
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'))).notarized, false);
  assert.match(fs.readFileSync(path.join(output, 'SHA256SUMS'), 'utf8'), /mGit_1.2.3_aarch64.dmg/);
  assert.equal(
    ctx.calls.filter((call) => call.program === '/usr/bin/codesign' && call.args[0] === '--verify')
      .length,
    2,
  );
  assert.throws(() => main(['macos'], ctx), /already exists/);
  assert.equal(fs.existsSync(path.join(root, 'release/.release.lock')), false);
});

for (const [name, overrides, expected] of [
  ['bad signature', { signatureFailure: true }, /invalid signature/],
  ['wrong certificate', { certificate: Buffer.from('other cert') }, /certificate/],
  ['wrong app version', { version: '9.9.9' }, /CFBundleShortVersionString/],
  ['wrong architecture', { arch: 'x86_64' }, /arm64/],
  ['wrong DMG app', { dmgBinary: 'wrong binary' }, /different application/],
  ['wrong Applications link', { applications: '/Other' }, /Applications link/],
])
  test(`packaging does not publish after ${name}`, () => {
    const root = fixture();
    const ctx = context(root, overrides);
    main(['tag'], ctx);
    assert.throws(() => main(['macos'], ctx), expected);
    assert.equal(fs.existsSync(path.join(root, 'release/v1.2.3')), false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'release')), []);
    if (overrides.dmgBinary || overrides.applications)
      assert.equal(
        ctx.calls.some((call) => call.program === '/usr/bin/hdiutil' && call.args[0] === 'detach'),
        true,
      );
  });

// 같은 버전 준비는 버전과 무관한 JSON 배치를 바꾸지 않는다.
test('same version preserves all manifest formatting', () => {
  for (const [file, content] of versionUpdates(
    ROOT,
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
  )) {
    assert.equal(content, fs.readFileSync(path.join(ROOT, file), 'utf8'));
  }
});
