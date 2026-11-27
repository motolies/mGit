//! 시스템 git 실행과 출력 파싱.
//!
//! 쓰기는 전부 git CLI로 하고 읽기도 `-z`(NUL 구분) 출력을 파싱한다.
//! `mgit-model` 의 [`GitRunner`](mgit_model::GitRunner) 포트를 tokio 프로세스로 구현한다.

pub mod cmd;
mod env;
pub use env::login_shell_path;
mod locate;
pub mod parse;
pub mod patch;
mod runner;

pub use locate::{LocateConfig, locate_git};
pub use runner::{RunnerConfig, TokioGitRunner, bulk_reads, in_bulk_reads, run_shell_command};
