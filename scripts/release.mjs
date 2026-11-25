import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_MANIFESTS = [
  'package.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
  ...['ipc', 'ui', 'graph-view', 'diff-view', 'merge-editor', 'terminal'].map(
    (name) => `packages/${name}/package.json`,
  ),
];
const MOCK_KEYS = ['VITE_MGIT_MOCK', 'VITE_MGIT_MOCK_SCENE'];
const TARGET = 'aarch64-apple-darwin';

/** 릴리스 버전은 macOS 메타데이터에 그대로 기록할 정규 X.Y.Z만 받는다. */
export function validateVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? ''))
    throw new Error('Version must be X.Y.Z without leading zeroes or prerelease/build suffixes.');
  return version;
}

/** 셸 해석 없이 명령을 실행하며 실패를 다음 단계로 넘기지 않는다. */
function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw new Error(`${program}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${program} failed (${result.status}): ${(result.stderr ?? '').trim()}`);
  return (result.stdout ?? '').trim();
}

/** 필요한 TOML 구획만 읽어 의존성 버전과 주석을 보존한다. */
function section(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = new RegExp(`^\\[${escaped}\\][^\\r\\n]*\\r?\\n`, 'm').exec(text);
  if (!start) throw new Error(`Missing TOML section [${name}].`);
  const from = start.index + start[0].length;
  const next = /^\[/m.exec(text.slice(from));
  return { from, to: next ? from + next.index : text.length };
}

/** TOML 버전 필드 하나만 확인하거나 교체한다. */
function tomlVersion(text, sectionName, version) {
  const { from, to } = section(text, sectionName);
  const body = text.slice(from, to);
  const matches = [...body.matchAll(/^version\s*=\s*"([^"]+)"/gm)];
  if (matches.length !== 1) throw new Error(`Expected one version in [${sectionName}].`);
  if (version === undefined) return matches[0][1];
  const updated = body.replace(
    /^(version\s*=\s*")[^"]+(".*)$/m,
    (_match, before, after) => `${before}${version}${after}`,
  );
  return text.slice(0, from) + updated + text.slice(to);
}

/** 워크스페이스 내부 crate 이름을 실제 매니페스트에서 얻는다. */
function internalCrates(root) {
  const files = ['apps/desktop/src-tauri/Cargo.toml', 'bench/mgit-bench/Cargo.toml'];
  for (const entry of fs.readdirSync(path.join(root, 'crates'), { withFileTypes: true }))
    if (entry.isDirectory() && fs.existsSync(path.join(root, 'crates', entry.name, 'Cargo.toml')))
      files.push(`crates/${entry.name}/Cargo.toml`);
  return files.map((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const bounds = section(text, 'package');
    const name = /^name\s*=\s*"([^"]+)"/m.exec(text.slice(bounds.from, bounds.to))?.[1];
    if (!name) throw new Error(`Missing package name: ${file}`);
    return name;
  });
}

/** Cargo.lock에서는 source 없는 내부 crate 버전만 갱신하며 외부 의존성은 그대로 둔다. */
export function syncCargoLock(text, names, version) {
  const found = new Set();
  const result = text.replace(
    /^\[\[package\]\][\s\S]*?(?=^\[\[package\]\]|$(?![\s\S]))/gm,
    (block) => {
      const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
      if (!names.includes(name) || /^source\s*=/m.test(block)) return block;
      if (found.has(name)) throw new Error(`Duplicate local Cargo.lock package: ${name}`);
      if ([...block.matchAll(/^version\s*=\s*"([^"]+)"/gm)].length !== 1)
        throw new Error(`Missing local Cargo.lock version: ${name}`);
      found.add(name);
      return block.replace(
        /^(version\s*=\s*")[^"]+(".*)$/m,
        (_match, before, after) => `${before}${version}${after}`,
      );
    },
  );
  for (const name of names)
    if (!found.has(name)) throw new Error(`Missing local Cargo.lock package: ${name}`);
  return result;
}

/** 버전 관련 파일을 미리 전부 검증한 뒤 변경 계획을 만든다. */
export function versionUpdates(root, version) {
  validateVersion(version);
  const updates = new Map();
  for (const file of JSON_MANIFESTS) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const data = JSON.parse(text);
    validateVersion(data.version);
    const fields = [...text.matchAll(/("version"\s*:\s*")[^"]*(")/g)];
    if (fields.length !== 1) throw new Error(`Ambiguous version field: ${file}`);
    updates.set(
      file,
      text.replace(
        /("version"\s*:\s*")[^"]*(")/,
        (_match, prefix, suffix) => `${prefix}${version}${suffix}`,
      ),
    );
  }
  for (const [file, name] of [
    ['Cargo.toml', 'workspace.package'],
    ['crates/mgit-syntax/Cargo.toml', 'package'],
  ]) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    validateVersion(tomlVersion(text, name));
    updates.set(file, tomlVersion(text, name, version));
  }
  updates.set(
    'Cargo.lock',
    syncCargoLock(
      fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8'),
      internalCrates(root),
      version,
    ),
  );
  return updates;
}

/** 태그를 만들거나 빌드하기 전에 모든 버전과 lockfile이 일치하는지 확인한다. */
export function checkVersions(root) {
  const version = validateVersion(
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  );
  const expected = versionUpdates(root, version);
  for (const [file, content] of expected) {
    const current = fs.readFileSync(path.join(root, file), 'utf8');
    if (file.endsWith('.json')) {
      if (JSON.parse(current).version !== version) throw new Error(`Version mismatch: ${file}`);
    } else if (current !== content) throw new Error(`Version mismatch: ${file}`);
  }
  return version;
}

/** 릴리스 화면에 mock 데이터가 포함되는 설정을 환경과 Vite 입력 파일 양쪽에서 차단한다. */
export function checkMock(root, env) {
  for (const key of MOCK_KEYS)
    if ((env[key] ?? '').trim()) throw new Error(`Unset ${key} before releasing.`);
  for (const dir of [root, path.join(root, 'apps/desktop')]) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !/^\.env(?:\..*)?$/.test(entry.name) ||
        /\.(example|sample)$/.test(entry.name)
      )
        continue;
      const text = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      if (/^\s*(?:export\s+)?VITE_MGIT_MOCK(?:_SCENE)?\s*=/m.test(text))
        throw new Error(
          `Mock setting in environment file: ${path.relative(root, path.join(dir, entry.name))}`,
        );
    }
  }
}

/** 추적 파일과 추적되지 않은 일반 파일까지 확인해 태그와 다른 소스를 빌드하지 않는다. */
function cleanHead(run, root) {
  if (run('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root }))
    throw new Error('Release requires a clean working tree (including untracked files).');
  return run('git', ['rev-parse', 'HEAD'], { cwd: root });
}

/** HEAD의 릴리스 태그가 하나이며 annotated tag이고 버전이 일치하는지 확인한다. */
export function checkTag(run, root, version) {
  const tags = run('git', ['tag', '--points-at', 'HEAD'], { cwd: root })
    .split(/\r?\n/)
    .filter((tag) => /^v\d/.test(tag));
  if (tags.length !== 1 || tags[0] !== `v${version}`)
    throw new Error(`HEAD must have exactly one release tag: v${version}`);
  if (run('git', ['cat-file', '-t', `refs/tags/${tags[0]}`], { cwd: root }) !== 'tag')
    throw new Error(`${tags[0]} must be an annotated tag.`);
  return tags[0];
}

/** 공개 pin과 키체인의 실제 서명 identity를 대조하며 암호를 읽거나 출력하지 않는다. */
export function checkIdentity(run, root, now = new Date()) {
  const pin = JSON.parse(
    fs.readFileSync(path.join(root, 'packaging/signing-identity.json'), 'utf8'),
  );
  if (
    pin.schemaVersion !== 1 ||
    pin.commonName !== 'mGit' ||
    !/^[A-F0-9]{40}$/.test(pin.sha1) ||
    !/^[A-F0-9]{64}$/.test(pin.sha256)
  )
    throw new Error('Invalid signing identity pin. Run signing:setup first.');
  if (!(Date.parse(pin.notAfter) > now.getTime())) throw new Error('Signing identity has expired.');
  const state = JSON.parse(
    run('swift', ['-suppress-warnings', 'scripts/signing-identity.swift', 'status', '--json'], {
      cwd: root,
    }),
  );
  if (
    state.status !== 'ready' ||
    ['commonName', 'sha1', 'sha256', 'notAfter'].some((key) => state[key] !== pin[key])
  )
    throw new Error(
      'Signing identity is missing, ambiguous, untrusted, or does not match the pin.',
    );
  return pin;
}

/** 파일을 스트림 없이 해시하고 공개 검증용 SHA-256 문자열로 반환한다. */
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 최종 앱의 버전·아키텍처·서명과 내장 leaf 인증서를 검증한다. */
export function verifyApp(run, app, expected, scratch) {
  const plist = path.join(app, 'Contents/Info.plist');
  const get = (key) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion'])
    if (get(key) !== expected.version)
      throw new Error(`${key} does not match v${expected.version}.`);
  if (get('CFBundleIdentifier') !== 'io.github.motolies.mgit')
    throw new Error('Unexpected bundle identifier.');
  if (get('LSMinimumSystemVersion') !== '15.0')
    throw new Error('Unexpected minimum macOS version.');
  const executable = get('CFBundleExecutable');
  if (executable !== 'mgit-desktop') throw new Error('Unexpected bundle executable.');
  const binary = path.join(app, 'Contents/MacOS', executable);
  if (run('/usr/bin/lipo', ['-archs', binary]).trim() !== 'arm64')
    throw new Error('Release must contain only arm64.');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const prefix = path.join(fs.mkdtempSync(path.join(scratch, 'certificate-')), 'leaf-');
  run('/usr/bin/codesign', ['--display', `--extract-certificates=${prefix}`, app]);
  const cert = `${prefix}0`;
  if (!fs.existsSync(cert) || sha256(cert).toUpperCase() !== expected.identity.sha256)
    throw new Error('Embedded signing certificate does not match the pinned identity.');
  return { binarySha256: sha256(binary), bundleVersion: expected.version };
}

/** DMG를 읽기 전용으로 붙여 안에 든 앱까지 확인한 뒤 반드시 해제한다. */
export function verifyDmg(run, dmg, expected, scratch, appInfo) {
  run('/usr/bin/hdiutil', ['verify', dmg]);
  const mount = path.join(scratch, 'mount');
  fs.mkdirSync(mount);
  let mounted = false;
  try {
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    mounted = true;
    if (fs.readlinkSync(path.join(mount, 'Applications')) !== '/Applications')
      throw new Error('DMG must contain an Applications link.');
    const contents = verifyApp(run, path.join(mount, 'mGit.app'), expected, scratch);
    if (contents.binarySha256 !== appInfo.binarySha256)
      throw new Error('DMG contains a different application binary.');
  } finally {
    if (mounted) run('/usr/bin/hdiutil', ['detach', mount]);
  }
}

/** mock·공증 자격 증명·외부 Tauri override를 넘기지 않고 지정 identity만 사용한다. */
function buildEnvironment(env, identity, targetDir) {
  const result = { ...env, APPLE_SIGNING_IDENTITY: identity.sha1, CARGO_TARGET_DIR: targetDir };
  for (const key of [
    ...MOCK_KEYS,
    'TAURI_CONFIG',
    'TAURI_ENV_DEBUG',
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID',
    'APPLE_API_KEY',
    'APPLE_API_ISSUER',
    'APPLE_API_KEY_PATH',
  ])
    delete result[key];
  return result;
}

/** 검증된 결과를 임시 폴더에서 완성한 뒤 버전 디렉터리로 한 번만 게시한다. */
function packageMacos(ctx, info) {
  const { root, run, env } = ctx;
  const releases = path.join(root, 'release');
  fs.mkdirSync(releases, { recursive: true });
  const output = path.join(releases, info.tag);
  if (fs.existsSync(output)) throw new Error(`Release already exists: release/${info.tag}`);
  const lock = path.join(releases, '.release.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  let stage;
  try {
    stage = fs.mkdtempSync(path.join(releases, `.staging-${info.tag}-`));
    const buildRoot = path.join(root, 'target');
    const bundle = path.join(buildRoot, TARGET, 'release/bundle');
    fs.rmSync(bundle, { recursive: true, force: true });
    run(
      'pnpm',
      [
        '-F',
        '@mgit/desktop',
        'tauri',
        'build',
        '--target',
        TARGET,
        '--bundles',
        'app,dmg',
        '--config',
        JSON.stringify({ bundle: { macOS: { signingIdentity: info.identity.sha1 } } }),
        '--',
        '--locked',
      ],
      {
        cwd: root,
        env: buildEnvironment(env, info.identity, buildRoot),
        stdio: 'inherit',
      },
    );
    const app = path.join(stage, 'mGit.app');
    const dmgName = `mGit_${info.version}_aarch64.dmg`;
    fs.cpSync(path.join(bundle, 'macos/mGit.app'), app, {
      recursive: true,
      preserveTimestamps: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
    });
    fs.copyFileSync(
      path.join(bundle, 'dmg', dmgName),
      path.join(stage, dmgName),
      fs.constants.COPYFILE_EXCL,
    );
    const scratch = fs.mkdtempSync(path.join(root, 'target/release-verify-'));
    let appInfo;
    try {
      appInfo = verifyApp(run, app, info, scratch);
      verifyDmg(run, path.join(stage, dmgName), info, scratch, appInfo);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    if (
      cleanHead(run, root) !== info.commit ||
      checkTag(run, root, checkVersions(root)) !== info.tag
    )
      throw new Error('Source changed during the release build.');
    const manifest = {
      schemaVersion: 1,
      product: 'mGit',
      version: info.version,
      tag: info.tag,
      commit: info.commit,
      target: TARGET,
      bundleIdentifier: 'io.github.motolies.mgit',
      minimumSystemVersion: '15.0',
      signing: info.identity,
      notarized: false,
      executableSha256: appInfo.binarySha256,
      dmgSha256: sha256(path.join(stage, dmgName)),
    };
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(
      path.join(stage, 'SHA256SUMS'),
      `${manifest.dmgSha256}  ${dmgName}\n${sha256(path.join(stage, 'manifest.json'))}  manifest.json\n${appInfo.binarySha256}  mGit.app/Contents/MacOS/mgit-desktop\n`,
    );
    if (fs.existsSync(output)) throw new Error(`Release already exists: release/${info.tag}`);
    fs.renameSync(stage, output);
    stage = undefined;
    return { ...info, output: path.relative(root, output) };
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

/** 릴리스 준비·검사·로컬 태그·macOS 패키징의 공통 진입점이다. */
export function main(args, options = {}) {
  const ctx = {
    root: ROOT,
    run: command,
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    now: new Date(),
    ...options,
  };
  const dryRun = args.includes('--dry-run');
  const values = args.filter((value) => value !== '--dry-run');
  const [action, versionArg, ...rest] = values;
  if (
    !['prepare', 'check', 'tag', 'macos'].includes(action) ||
    rest.length ||
    (action !== 'prepare' && versionArg !== undefined)
  )
    throw new Error('Usage: release.mjs prepare X.Y.Z|check|tag|macos [--dry-run]');
  if (action === 'prepare') {
    const updates = versionUpdates(ctx.root, versionArg);
    if (!dryRun) {
      cleanHead(ctx.run, ctx.root);
      for (const [file, text] of updates) fs.writeFileSync(path.join(ctx.root, file), text);
    }
    return { action, version: versionArg, dryRun, files: [...updates.keys()] };
  }
  const version = checkVersions(ctx.root);
  const commit = cleanHead(ctx.run, ctx.root);
  checkMock(ctx.root, ctx.env);
  if (action === 'tag') {
    const tag = `v${version}`;
    const existing = ctx.run('git', ['tag', '--list', tag], { cwd: ctx.root });
    if (existing) throw new Error(`Tag already exists: ${tag}`);
    const headTags = ctx
      .run('git', ['tag', '--points-at', 'HEAD'], { cwd: ctx.root })
      .split(/\r?\n/)
      .filter((name) => /^v\d/.test(name));
    if (headTags.length) throw new Error('HEAD already has a release tag.');
    if (!dryRun)
      ctx.run('git', ['-c', 'tag.gpgSign=false', 'tag', '-a', tag, '-m', `mGit ${tag}`, commit], {
        cwd: ctx.root,
      });
    return { action, version, tag, commit, dryRun, pushed: false };
  }
  const tag = checkTag(ctx.run, ctx.root, version);
  if (ctx.platform !== 'darwin' || ctx.arch !== 'arm64')
    throw new Error('Release requires a native Apple Silicon macOS host.');
  const identity = checkIdentity(ctx.run, ctx.root, ctx.now);
  const info = { action, version, tag, commit, identity, dryRun };
  if (action === 'check' || dryRun) return { ...info, output: `release/${tag}`, target: TARGET };
  return packageMacos(ctx, info);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
