/** 변경 종류 글자 (A/D/R/C/T/M) */
export function changeLetter(kind: string): string {
  switch (kind) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'typeChanged':
      return 'T';
    default:
      return 'M';
  }
}
