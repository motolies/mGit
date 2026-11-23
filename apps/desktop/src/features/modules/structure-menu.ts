// 저장소 탭 Project 도구 창 머리의 모듈·서브모듈·하위 저장소 메뉴 (W25, PT-13 — 계획 4절의 `(⋮)`). 파일 트리는 펼친
// 디렉터리만 보이므로, 옛 사이드바가 늘 목록으로 보이던 세 가지를 접힌 곳에 있어도 닿게 한다. 구조(보이는 조건·항목·
// 라벨·꺼짐·현재 표시)는 여기의 순수 함수가, 실행은 주입한 동작이 맡는다 (W22~W24 와 같은 방식).
//
// 옛 사이드바와의 대응:
// - 모듈 섹션: 보이는 조건(모듈이 있거나 범위가 걸림), "전체"(범위 없으면 현재 — 꺼지지 않음), 모듈(변경 수, 지금 범위면
//   현재, 고르면 범위 토글 — busy 면 꺼짐), 머리의 "직접 추가…"(busy 면 꺼짐)·"다시 감지". 고르면 트리에서 그 디렉터리를
//   드러낸다 (새것)
// - 서브모듈 섹션: 보이는 조건(서브모듈이 있음), 머리 4단추(busy·진행 중 작업이면 꺼짐), 행(경로 + 상태 문구). 고르면 트리에서
//   그 디렉터리를 드러낸다 (옛 더블클릭 = 탭으로 열기는 행 메뉴의 "열기")
// - 하위 저장소 섹션: 보이는 조건(있음), 행(저장소 이름). 고르면 트리에서 드러낸다 (탭으로 열기는 행 메뉴)

import type { Module, StatusEntry, SubmoduleInfo } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { DropdownItem } from '../../components/DropdownMenu';
import { repoNameOf } from '../../store';
import { relativeTo } from '../../store/fs-path';
import { changesInModule } from './module-groups';

/** 메뉴가 보는 세션 상태 */
export interface StructureMenuState {
  /** 작업 트리의 절대 경로 */
  root: string;
  modules: readonly Module[];
  /** 지금 모듈 범위. null 이면 전체 */
  scope: string | null;
  entries: readonly StatusEntry[];
  submodules: readonly SubmoduleInfo[];
  /** 추적되지 않는 하위 저장소의 절대 경로 */
  nestedRepos: readonly string[];
  /** 쓰기 명령이 도는 중 */
  busy: boolean;
  /** merge·rebase 등 진행 중 작업이 있음 */
  inOp: boolean;
}

/** 메뉴가 거는 동작 (컨테이너가 주입한다) */
export interface StructureMenuActions {
  /** 모듈 범위를 바꾼다 (null = 전체) */
  selectModule(path: string | null): void;
  /** 트리에서 그 디렉터리를 드러낸다 (조상을 펼치고 그 행을 고른다, 작업 트리 기준 경로) */
  reveal(path: string): void;
  addModule(): void;
  reloadModules(): void;
  addSubmodule(): void;
  syncSubmodules(): void;
  batchSubmodules(): void;
  /** 재귀 update */
  updateSubmodules(): void;
}

/** 라디오 묶음에서 "전체"(범위 없음)의 값. 모듈 경로는 비지 않는다 (코어가 빈 경로를 거부한다) */
export const ALL_MODULES = '';

/** 모듈 묶음이 보이는지 (옛 섹션: 모듈이 하나도 없고 범위도 없으면 숨김) */
export function showsModules(s: Pick<StructureMenuState, 'modules' | 'scope'>): boolean {
  return s.modules.length > 0 || s.scope !== null;
}

/** 메뉴 단추가 보이는지: 묶음이 하나라도 보일 때 */
export function structureMenuShown(
  s: Pick<StructureMenuState, 'modules' | 'scope' | 'submodules' | 'nestedRepos'>,
): boolean {
  return showsModules(s) || s.submodules.length > 0 || s.nestedRepos.length > 0;
}

/** 단추 툴팁의 둘째 줄: 보이는 묶음의 개수 (`모듈 5 · 서브모듈 5 · 하위 저장소 2`) */
export function structureCounts(
  s: Pick<StructureMenuState, 'modules' | 'scope' | 'submodules' | 'nestedRepos'>,
): string {
  const t = S.project.structure;
  return t.counts([
    ...(showsModules(s) ? [t.modules(s.modules.length)] : []),
    ...(s.submodules.length > 0 ? [t.submodules(s.submodules.length)] : []),
    ...(s.nestedRepos.length > 0 ? [t.nested(s.nestedRepos.length)] : []),
  ]);
}

/**
 * 모듈 항목의 글자: 이름 + 그 안의 변경 수. 이름이 같은 모듈이 둘 이상이면 경로를 붙여 가른다 (코어는 디렉터리 이름을
 * 모듈 이름으로 쓰므로 `services/api`·`clients/api` 처럼 겹칠 수 있다)
 */
function moduleOptionLabel(m: Module, s: Pick<StructureMenuState, 'modules' | 'entries'>): string {
  const twin = s.modules.some((x) => x !== m && x.name === m.name);
  const name = twin ? `${m.name} (${m.path})` : m.name;
  return S.project.structure.moduleOption(name, changesInModule(m.path, s.entries));
}

/** 모듈 묶음: 머리 + "전체"·모듈 라디오 + 직접 추가·다시 감지 */
function moduleSection(s: StructureMenuState, act: StructureMenuActions): DropdownItem[] {
  const t = S.modules;
  return [
    { kind: 'label', label: S.project.structure.modules(s.modules.length) },
    {
      kind: 'radio',
      value: s.scope ?? ALL_MODULES,
      // 고르면 닫는다: 트리에서 드러낸 행이 메뉴에 가리지 않게. "전체" 는 busy 여도 켜져 있다 (옛 그대로 — 모듈만 꺼진다)
      closeOnSelect: true,
      // 옛 행 클릭과 같다: 지금 범위인 모듈을 다시 고르면 범위가 풀린다. 모듈을 고르면 트리에서 그 디렉터리를 드러낸다
      onChange: (value) => {
        if (value === ALL_MODULES) {
          act.selectModule(null);
          return;
        }
        act.selectModule(value === s.scope ? null : value);
        act.reveal(value);
      },
      options: [
        { value: ALL_MODULES, label: t.all },
        ...s.modules.map((m) => ({
          value: m.path,
          label: moduleOptionLabel(m, s),
          disabled: s.busy,
        })),
      ],
    },
    { kind: 'item', label: t.add, disabled: s.busy, onSelect: act.addModule },
    { kind: 'item', label: t.reload, onSelect: act.reloadModules },
  ];
}

/** 서브모듈 묶음: 머리 + 옛 머리 4단추 + 서브모듈 목록 */
function submoduleSection(s: StructureMenuState, act: StructureMenuActions): DropdownItem[] {
  const t = S.submodule;
  const disabled = s.busy || s.inOp;
  return [
    { kind: 'label', label: S.project.structure.submodules(s.submodules.length) },
    { kind: 'item', label: t.add, disabled, onSelect: act.addSubmodule },
    { kind: 'item', label: t.sync, disabled, onSelect: act.syncSubmodules },
    { kind: 'item', label: t.batch, disabled, onSelect: act.batchSubmodules },
    { kind: 'item', label: t.updateRecursive, disabled, onSelect: act.updateSubmodules },
    { kind: 'separator' },
    ...s.submodules.map(
      (sm): DropdownItem => ({
        kind: 'item',
        label: S.project.structure.submoduleOption(sm.path, t.status[sm.status]),
        onSelect: () => act.reveal(sm.path),
      }),
    ),
  ];
}

/** 하위 저장소 묶음: 머리 + 저장소 목록 (작업 트리 밖 경로는 트리에 없으므로 뺀다) */
function nestedSection(s: StructureMenuState, act: StructureMenuActions): DropdownItem[] {
  const rows = s.nestedRepos.flatMap((abs): DropdownItem[] => {
    const rel = relativeTo(s.root, abs);
    return rel === null || rel === ''
      ? []
      : [{ kind: 'item', label: repoNameOf(abs), onSelect: () => act.reveal(rel) }];
  });
  return [{ kind: 'label', label: S.project.structure.nested(s.nestedRepos.length) }, ...rows];
}

/** 메뉴 항목 전체: 보이는 묶음만, 묶음 사이에 구분선 */
export function structureMenuItems(
  s: StructureMenuState,
  act: StructureMenuActions,
): DropdownItem[] {
  const sections = [
    showsModules(s) ? moduleSection(s, act) : [],
    s.submodules.length > 0 ? submoduleSection(s, act) : [],
    s.nestedRepos.length > 0 ? nestedSection(s, act) : [],
  ].filter((section) => section.length > 0);
  return sections.flatMap((section, i): DropdownItem[] =>
    i === 0 ? section : [{ kind: 'separator' }, ...section],
  );
}
