// 줄 끝이 섞인 파일 (LF·CRLF·단독 CR): 편집기는 줄 끝 하나만 다루므로 내용을 읽기 전용으로 보이고, 위의 안내 띠에서
// 사용자가 고른 형식으로 통일해 저장한 뒤 편집기로 연다. 통일은 파일 전체의 줄 끝을 바꾸므로 확인을 먼저 받는다.

import type { FsEditableFile, FsLineEnding } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { type ReactNode, useMemo, useState } from 'react';
import { useDialogs } from '../../components/use-dialogs';
import { type FileLoad, FileView, type FileViewRepoTools } from './FileView';
import styles from './FileView.module.css';

/** 줄 끝이 섞인 파일의 편집 조회 결과 */
export type MixedLineEndingsFile = Extract<FsEditableFile, { kind: 'mixedLineEndings' }>;

/** 화면에 쓰는 줄 끝 이름 */
const LINE_ENDING_LABEL: Record<FsLineEnding, string> = { lf: 'LF', crlf: 'CRLF' };

/** `target` 으로 통일하면 줄 끝이 바뀌는 줄 수: 목표가 아닌 줄 끝과 단독 CR */
export function changedLineEndings(file: MixedLineEndingsFile, target: FsLineEnding): number {
  return (target === 'lf' ? file.crlf : file.lf) + file.cr;
}

export interface MixedLineEndingsViewProps {
  /** 루트 기준 상대 경로 (머리줄·구문 강조 언어) */
  path: string;
  file: MixedLineEndingsFile;
  repoTools?: FileViewRepoTools | null;
  /** 확인을 받은 뒤 부르는 통일 저장. 통일하지 못했으면 띠에 보일 사유를, 성공이면 null 을 돌려준다 */
  onNormalize: (target: FsLineEnding) => Promise<string | null>;
  /** 머리줄의 인코딩 단추 (R2). 없으면 그리지 않는다 */
  encoding?: ReactNode;
}

/**
 * 줄 끝이 섞인 파일의 화면: 파일 보기(강조·큰 파일 규칙 그대로)를 읽기 전용으로 보이고, 머리줄 아래 띠에 줄 끝 수와
 * "LF로 통일해 편집"·"CRLF로 통일해 편집" 단추를 둔다. 단추는 바뀌는 줄 수를 알리는 확인을 거친 뒤 `onNormalize` 를
 * 부르고, 도는 동안 꺼진다
 */
export function MixedLineEndingsView({
  path,
  file,
  repoTools = null,
  onNormalize,
  encoding = null,
}: MixedLineEndingsViewProps) {
  const dialogs = useDialogs();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const t = S.fileEditor;
  const counts = t.lineEndingCounts(file.lf, file.crlf, file.cr);
  const load = useMemo<FileLoad>(
    () => ({ state: 'loaded', file: { kind: 'text', text: file.text, size: file.size } }),
    [file.text, file.size],
  );

  /** 바뀌는 줄 수를 알리고 확인을 받은 뒤 통일 저장을 부른다. 통일하지 못한 사유는 띠에 남긴다 */
  const normalize = async (target: FsLineEnding) => {
    const label = LINE_ENDING_LABEL[target];
    const confirmed = await dialogs.confirm({
      title: t.normalizeTitle(label),
      message: t.normalizeMessage(label, counts, changedLineEndings(file, target), file.cr),
      confirmLabel: t.normalizeAction(label),
    });
    if (!confirmed) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      setFailure(await onNormalize(target));
    } finally {
      setBusy(false);
    }
  };

  const banner = (
    <div className={styles.notice}>
      <span className={styles.noticeText} role="status">
        {t.mixedReadOnly(counts)}
      </span>
      <Button disabled={busy} onClick={() => void normalize('lf')}>
        {t.normalizeLf}
      </Button>
      <Button disabled={busy} onClick={() => void normalize('crlf')}>
        {t.normalizeCrlf}
      </Button>
      {failure ? (
        <span className={styles.noticeError} role="alert">
          {failure}
        </span>
      ) : null}
    </div>
  );

  return (
    <>
      <FileView
        path={path}
        repoTools={repoTools}
        banner={banner}
        encoding={encoding}
        load={load}
        onRetry={() => {}}
      />
      {dialogs.element}
    </>
  );
}
