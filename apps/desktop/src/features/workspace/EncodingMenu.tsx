// 파일의 인코딩 표시와 "다른 인코딩으로 다시 열기" 메뉴 (R2). 편집기 머리줄(`UTF-8 · LF · …`의 인코딩 자리)과 읽기 전용
// 파일 보기(줄 끝 혼합·다시 쓸 수 없는 파일·읽지 못한 파일)의 머리줄에 같은 단추를 둔다. 다시 여는 일은 컨테이너가 한다.

import type { FsEncoding } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { type DropdownItem, DropdownMenu } from '../../components/DropdownMenu';
import styles from './EncodingMenu.module.css';

/** 고를 수 있는 인코딩 (코어 `FsEncoding` 과 같은 차례) */
export const ENCODINGS: readonly FsEncoding[] = [
  'utf8',
  'utf16Le',
  'utf16Be',
  'eucKr',
  'shiftJis',
  'eucJp',
  'gb18030',
  'big5',
  'windows1252',
];

/** 화면에 쓰는 인코딩 이름 (표준 이름이라 언어마다 같다) */
const NAMES: Record<FsEncoding, string> = {
  utf8: 'UTF-8',
  utf16Le: 'UTF-16 LE',
  utf16Be: 'UTF-16 BE',
  eucKr: 'EUC-KR',
  shiftJis: 'Shift_JIS',
  eucJp: 'EUC-JP',
  gb18030: 'GB18030',
  big5: 'Big5',
  windows1252: 'Windows-1252',
};

/** 인코딩의 화면 이름 */
export function encodingName(encoding: FsEncoding): string {
  return NAMES[encoding];
}

export interface EncodingMenuProps {
  /** 지금 인코딩. 어느 인코딩으로도 읽지 못했으면 null ("인코딩 골라 열기…") */
  encoding: FsEncoding | null;
  /** 이름 뒤에 `BOM` 을 붙일지 (편집기 머리줄 — 파일 보기는 따로 BOM 표지가 있다) */
  bom?: boolean;
  /** 코어가 후보 중에서 고른 인코딩인지. 이름 뒤에 "추정" 을 붙이고 툴팁으로 까닭을 알린다 */
  guessed?: boolean;
  /** 사용자가 고른 인코딩으로 열려 있는지. 메뉴에 "자동으로 알아내기" 를 둔다 */
  chosen?: boolean;
  /** 바꿀 수 없는 까닭 (저장하지 않은 편집). 있으면 메뉴를 열지 않고 툴팁으로 알린다 */
  locked?: string | null;
  /** 고른 인코딩으로 다시 연다. null 이면 자동으로 되돌린다 */
  onChoose: (encoding: FsEncoding | null) => void;
}

/**
 * 인코딩 단추: 지금 인코딩 이름을 글자 그대로 보이고, 누르면 인코딩 목록(라디오)에서 골라 다시 연다. 바꿀 수 없으면 꺼진
 * 모양으로 까닭을 툴팁에 둔다 (꺼진 단추는 툴팁이 뜨지 않는 웹뷰가 있어 `aria-disabled` 로 둔다)
 */
export function EncodingMenu({
  encoding,
  bom = false,
  guessed = false,
  chosen = false,
  locked = null,
  onChoose,
}: EncodingMenuProps) {
  const t = S.fileEditor;
  const name = encoding === null ? null : NAMES[encoding];
  const label =
    name === null
      ? t.encodingPick
      : `${name}${bom ? ' BOM' : ''}${guessed ? ` (${t.encodingGuessedTag})` : ''}`;
  const title = locked ?? (guessed && name !== null ? t.encodingGuessed(name) : t.encodingTitle);
  if (locked) {
    return (
      <button
        type="button"
        className={styles.button}
        aria-label={t.encoding(label)}
        aria-disabled="true"
        title={title}
      >
        {label}
      </button>
    );
  }
  const items: DropdownItem[] = [
    { kind: 'label', label: t.encodingReopen },
    {
      kind: 'radio',
      value: encoding ?? '',
      options: ENCODINGS.map((value) => ({ value, label: NAMES[value] })),
      onChange: (value) => onChoose(value as FsEncoding),
      closeOnSelect: true,
    },
  ];
  if (chosen) {
    items.push(
      { kind: 'separator' },
      { kind: 'item', label: t.encodingAuto, onSelect: () => onChoose(null) },
    );
  }
  return (
    <DropdownMenu
      align="start"
      items={items}
      trigger={
        <button
          type="button"
          className={styles.button}
          aria-label={t.encoding(label)}
          title={title}
        >
          {label}
        </button>
      }
    />
  );
}
