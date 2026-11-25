import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = fileURLToPath(new URL('../signing-identity.swift', import.meta.url));

/** 실제 키체인·키 생성 없이 CLI의 정책 검증과 인자 경계를 실행한다. */
function run(...args) {
  return spawnSync('/usr/bin/swift', ['-suppress-warnings', script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90_000,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME },
  });
}

test('Swift 서명 도구가 실제 SDK Security API와 타입 검사된다', () => {
  const result = spawnSync('/usr/bin/swiftc', ['-typecheck', '-suppress-warnings', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90_000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test('정확한 CN·지문, 암호 길이, 비공개 권한과 덮어쓰기 거부를 독립 검증한다', () => {
  const result = run('self-test');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PASS:/);
  assert.match(result.stdout, /키체인·키 생성 없음/);
});

test('암호 전달 인자는 거부하고 그 값을 오류에 되풀이하지 않는다', () => {
  const marker = 'synthetic-do-not-echo-marker';
  const result = run('import', '--password', marker);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(marker));
  assert.match(result.stderr, /암호는 인자나 환경변수로 받지 않습니다/);
});

test('import와 verify-backup은 백업 폴더를 명시해야 한다', () => {
  for (const command of ['import', 'verify-backup']) {
    const result = run(command);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--bundle/);
  }
});

test('help는 키체인 접근 없이 지원 명령을 보여 준다', () => {
  const result = run('help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verify-backup/);
  assert.match(result.stdout, /self-test/);
});
