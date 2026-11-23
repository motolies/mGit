/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 개발 모드에서 합성 그래프 행 수. 설정하면 코어 대신 목 클라이언트를 쓴다 */
  readonly VITE_MGIT_MOCK?: string;
  /**
   * 목 모드의 장면: `folder`(여러 저장소 폴더) | `repo`(단일 저장소) | `conflict`(merge 충돌).
   * `VITE_MGIT_MOCK` 과 함께 줄 때만 쓰이고, 없으면 단일 저장소의 합성 그래프만 나온다
   */
  readonly VITE_MGIT_MOCK_SCENE?: string;
}
