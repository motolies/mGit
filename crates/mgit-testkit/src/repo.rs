use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use mgit_model::Oid;
use tempfile::TempDir;

use crate::env::DeterministicEnv;

/// 임시 디렉터리 안의 결정적 git 저장소. 드롭되면 지워진다
pub struct TestRepo {
    _dir: TempDir,
    /// `<tmp>/repo`. gitconfig 가 작업 트리에 섞이지 않도록 한 단계 아래에 둔다
    work_tree: PathBuf,
    env: DeterministicEnv,
    clock: i64,
    file_counter: u32,
}

impl TestRepo {
    /// `git init -b main` 으로 빈 저장소를 만든다
    pub fn init() -> Self {
        let dir = TempDir::new().expect("임시 디렉터리 생성 실패");
        let env = DeterministicEnv::create(dir.path()).expect("gitconfig 쓰기 실패");
        let work_tree = dir.path().join("repo");
        std::fs::create_dir(&work_tree).expect("repo 디렉터리 생성 실패");
        let mut repo = TestRepo {
            _dir: dir,
            work_tree,
            env,
            clock: DeterministicEnv::EPOCH_START,
            file_counter: 0,
        };
        repo.git_ok(["init", "-q", "-b", "main"]);
        repo
    }

    /// 이미 있는 저장소 경로를 감싼다 (결정적 env 는 새 임시 디렉터리에 둔다)
    pub fn at(path: &Path) -> Self {
        let dir = TempDir::new().expect("임시 디렉터리 생성 실패");
        let env = DeterministicEnv::create(dir.path()).expect("gitconfig 쓰기 실패");
        TestRepo {
            _dir: dir,
            work_tree: path.to_path_buf(),
            env,
            clock: DeterministicEnv::EPOCH_START,
            file_counter: 0,
        }
    }

    /// 작업 트리 경로
    pub fn path(&self) -> &Path {
        &self.work_tree
    }

    /// git 을 결정적 환경으로 실행한다. 실패해도 panic 하지 않는다
    pub fn git<I, S>(&mut self, args: I) -> Output
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.git_with_stdin(args, None)
    }

    /// stdin 을 넘겨 실행한다
    pub fn git_with_stdin<I, S>(&mut self, args: I, stdin: Option<&[u8]>) -> Output
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(self.path());
        self.env.apply(&mut cmd, self.clock);
        match stdin {
            Some(bytes) => {
                cmd.stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                let mut child = cmd.spawn().expect("git 실행 실패");
                if let Some(mut pipe) = child.stdin.take() {
                    pipe.write_all(bytes).expect("stdin 쓰기 실패");
                }
                child.wait_with_output().expect("git 대기 실패")
            }
            None => {
                cmd.stdin(Stdio::null());
                cmd.output().expect("git 실행 실패")
            }
        }
    }

    /// 실행이 실패하면 stderr 와 함께 panic 한다. stdout 을 lossy 문자열로 돌려준다
    pub fn git_ok<I, S>(&mut self, args: I) -> String
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let args: Vec<String> = args
            .into_iter()
            .map(|a| a.as_ref().to_string_lossy().into_owned())
            .collect();
        let out = self.git(&args);
        assert!(
            out.status.success(),
            "git {} 실패: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// 원시 stdout 바이트 (fixture 생성용)
    pub fn git_bytes<I, S>(&mut self, args: I) -> Vec<u8>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let out = self.git(args);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        out.stdout
    }

    /// 파일을 쓴다. 중간 디렉터리도 만든다
    pub fn write_file(&mut self, rel: &str, body: &str) {
        let p = self.path().join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("디렉터리 생성 실패");
        }
        std::fs::write(p, body).expect("파일 쓰기 실패");
    }

    /// 새 파일 하나를 쓰고 커밋한다. 메시지는 stdin 으로 넘겨 한글·빈 메시지도 안전하다
    pub fn commit(&mut self, msg: &str) -> Oid {
        self.file_counter += 1;
        let name = format!("f{}.txt", self.file_counter);
        self.write_file(&name, msg);
        self.clock += 60;
        self.git_ok(["add", "-A"]);
        let out = self.git_with_stdin(
            [
                "commit",
                "-q",
                "--allow-empty",
                "--allow-empty-message",
                "-F",
                "-",
            ],
            Some(msg.as_bytes()),
        );
        assert!(
            out.status.success(),
            "commit 실패: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        self.head()
    }

    /// 결정적 시계를 앞으로 옮긴다 (저장소 간 커밋 시각을 엇갈리게 할 때)
    pub fn advance_clock(&mut self, secs: i64) {
        self.clock += secs;
    }

    /// 브랜치를 만든다 (체크아웃하지 않음)
    pub fn branch(&mut self, name: &str) {
        self.git_ok(["branch", name]);
    }

    /// 기존 브랜치·커밋·태그로 체크아웃. `--` 를 뒤에 둬 ref 로 해석되게 한다
    pub fn checkout(&mut self, target: &str) {
        self.git_ok(["checkout", "-q", target, "--"]);
    }

    /// 새 브랜치를 만들며 체크아웃
    pub fn checkout_new(&mut self, name: &str) {
        self.git_ok(["checkout", "-q", "-b", name]);
    }

    /// 고아 브랜치. 기존 파일은 모두 지운다
    pub fn checkout_orphan(&mut self, name: &str) {
        self.git_ok(["checkout", "-q", "--orphan", name]);
        let _ = self.git(["rm", "-rfq", "."]);
    }

    /// `--no-ff` 머지. 둘 이상이면 옥토퍼스
    pub fn merge(&mut self, branches: &[&str], msg: &str) -> Oid {
        self.clock += 60;
        let mut args = vec!["merge", "-q", "--no-ff", "-m", msg];
        args.extend_from_slice(branches);
        self.git_ok(args);
        self.head()
    }

    /// 태그 생성
    pub fn tag(&mut self, name: &str, annotated: bool) {
        self.clock += 60;
        if annotated {
            self.git_ok(["tag", "-a", "-m", name, "--", name]);
        } else {
            self.git_ok(["tag", "--", name]);
        }
    }

    /// 작업 트리의 파일을 지운다
    pub fn remove_file(&mut self, rel: &str) {
        let _ = std::fs::remove_file(self.path().join(rel));
    }

    /// 경로들을 stage 한다
    pub fn stage(&mut self, paths: &[&str]) {
        let mut args = vec!["add", "--"];
        args.extend_from_slice(paths);
        self.git_ok(args);
    }

    /// 같은 파일을 두 브랜치에서 다르게 고쳐 충돌 준비를 한다.
    /// `main` 에 `conflict.txt` 를 만들고, `other` 브랜치와 `main` 이 각각 다른 내용으로 고친다.
    /// 끝나면 `main` 이 체크아웃돼 있다
    pub fn prepare_conflict(&mut self) {
        self.write_file("conflict.txt", "line1\nline2\nline3\n");
        self.clock += 60;
        self.stage(&["conflict.txt"]);
        self.commit_staged("base");
        self.checkout_new("other");
        self.write_file("conflict.txt", "line1\nTHEIRS\nline3\n");
        self.stage(&["conflict.txt"]);
        self.commit_staged("other change");
        self.checkout("main");
        self.write_file("conflict.txt", "line1\nOURS\nline3\n");
        self.stage(&["conflict.txt"]);
        self.commit_staged("main change");
    }

    /// stage 된 내용으로 커밋한다 (파일 추가 없음)
    pub fn commit_staged(&mut self, msg: &str) -> Oid {
        self.clock += 60;
        let out = self.git_with_stdin(
            ["commit", "-q", "--allow-empty", "-F", "-"],
            Some(msg.as_bytes()),
        );
        assert!(
            out.status.success(),
            "commit 실패: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        self.head()
    }

    /// `prepare_conflict` 뒤 `git merge other` 를 실행해 충돌 상태로 둔다
    pub fn begin_merge_conflict(&mut self) {
        self.clock += 60;
        let out = self.git(["merge", "--no-edit", "other"]);
        assert!(!out.status.success(), "충돌이 나야 한다");
    }

    /// `prepare_conflict` 뒤 `other` 를 `main` 위로 rebase 해 충돌 상태로 둔다 (other 체크아웃)
    pub fn begin_rebase_conflict(&mut self) {
        self.checkout("other");
        self.clock += 60;
        let out = self.git(["rebase", "main"]);
        assert!(!out.status.success(), "충돌이 나야 한다");
    }

    /// `prepare_conflict` 뒤 `other` 의 커밋을 cherry-pick 해 충돌 상태로 둔다
    pub fn begin_cherry_pick_conflict(&mut self) {
        self.clock += 60;
        let out = self.git(["cherry-pick", "other"]);
        assert!(!out.status.success(), "충돌이 나야 한다");
    }

    /// 워크트리를 만든다. `branch` 가 있으면 새 브랜치로, 없으면 detached
    pub fn add_worktree(&mut self, rel: &str, branch: Option<&str>) -> PathBuf {
        let path = self._dir.path().join(rel);
        let path_str = path.to_string_lossy().into_owned();
        match branch {
            Some(b) => self.git_ok(["worktree", "add", "-b", b, &path_str]),
            None => self.git_ok(["worktree", "add", "--detach", &path_str]),
        };
        path
    }

    /// 스태시를 만든다
    pub fn stash_push(&mut self, message: &str, include_untracked: bool) {
        self.clock += 60;
        let mut args = vec!["stash", "push", "-q", "-m", message];
        if include_untracked {
            args.push("-u");
        }
        self.git_ok(args);
    }

    /// 이 저장소를 원격으로 둔 bare 저장소를 만들고 `origin` 으로 등록한다. 경로를 돌려준다
    pub fn add_bare_remote(&mut self) -> PathBuf {
        self.add_bare_remote_named("origin")
    }

    /// bare 저장소를 만들고 `name` 원격으로 등록한다. 원격을 여럿 둘 때 쓴다
    pub fn add_bare_remote_named(&mut self, name: &str) -> PathBuf {
        let remote = self._dir.path().join(format!("remote-{name}.git"));
        let out = Command::new("git")
            .args(["init", "-q", "--bare", "-b", "main"])
            .arg(&remote)
            .output()
            .expect("git 실행 실패");
        assert!(out.status.success());
        let remote_str = remote.to_string_lossy().into_owned();
        self.git_ok(["remote", "add", name, &remote_str]);
        remote
    }

    /// 현재 HEAD 커밋
    pub fn head(&mut self) -> Oid {
        let s = self.git_ok(["rev-parse", "HEAD"]);
        Oid::from_hex(s.trim().as_bytes()).expect("HEAD 해시 파싱 실패")
    }

    /// 모든 ref 에서 도달 가능한 커밋 수
    pub fn rev_list_count(&mut self) -> u32 {
        let s = self.git_ok(["rev-list", "--all", "--count"]);
        s.trim().parse().expect("rev-list --count 파싱 실패")
    }

    /// 결정적 환경 (외부에서 같은 설정으로 git 을 실행할 때)
    pub fn env(&self) -> &DeterministicEnv {
        &self.env
    }
}

impl TestRepo {
    /// hook 스크립트를 설치한다 (`.git/hooks/<name>`, 실행 권한 부여)
    pub fn install_hook(&mut self, name: &str, body: &str) {
        let hooks = self.path().join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).expect("hooks 디렉터리 생성 실패");
        let path = hooks.join(name);
        std::fs::write(&path, body).expect("hook 쓰기 실패");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("hook 권한 설정 실패");
        }
    }

    /// 파일 내용을 읽는다
    pub fn read_file(&self, rel: &str) -> String {
        std::fs::read_to_string(self.path().join(rel)).expect("파일 읽기 실패")
    }
}

impl TestRepo {
    /// `source` 저장소를 `rel` 경로의 서브모듈로 추가하고 커밋한다 (로컬 file 프로토콜 허용)
    pub fn add_submodule(&mut self, rel: &str, source: &Path) -> Oid {
        let src = source.to_string_lossy().into_owned();
        self.git_ok([
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            &src,
            rel,
        ]);
        self.commit_staged(&format!("add submodule {rel}"))
    }
}
