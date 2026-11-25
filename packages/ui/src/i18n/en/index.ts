import type { Strings } from '../../strings';
import { enProjectEdit } from '../project-edit';
import { enRepository } from './repository';
import { enTools } from './tools';
import { enWorkspace } from './workspace';

// 영어 사전 (ko.ts 와 같은 모양). 섹션 묶음 세 파일을 합친다: 작업 공간(workspace)·저장소(repository)·도구(tools)

/**
 * 섹션 묶음 둘을 합친다. 같은 최상위 섹션이 양쪽에 있으면 `b` 의 타입이 never 가 되어 컴파일 오류가 난다 (전개
 * 연산자는 겹친 키를 조용히 덮어쓰므로 타입으로 막는다)
 */
function joinSections<A extends object, B extends object>(
  a: A,
  b: B & ([keyof A & keyof B] extends [never] ? unknown : never),
): A & B {
  return { ...a, ...b };
}

/** 영어 사전. `Strings` 주석이 최상위 섹션이 빠짐없이 들어갔는지 검사한다 */
export const en: Strings = joinSections(
  joinSections(joinSections(enWorkspace, enRepository), enTools),
  { projectEdit: enProjectEdit },
);
