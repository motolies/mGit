use std::path::Path;

use mgit_model::{ChangedFile, DiffChange, EnvProfile, GitError, GitRequest, GitRunner, Oid};

/// 커밋 메타데이터 (`git log -1`)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitMeta {
    pub oid: Oid,
    pub parents: Vec<Oid>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_time: i64,
    /// 전체 메시지 (`%B`, 끝 줄바꿈 제거)
    pub message: String,
}

/// 커밋 하나의 메타데이터를 읽는다. 필드는 NUL 구분, 레코드는 NUL 종료 9필드
pub async fn commit_meta(
    runner: &dyn GitRunner,
    work_tree: &Path,
    oid: &Oid,
) -> Result<CommitMeta, GitError> {
    let req = GitRequest::new(
        work_tree,
        [
            "log",
            "-1",
            "-z",
            "--no-show-signature",
            "--no-color",
            "--encoding=UTF-8",
            "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%cN%x00%cE%x00%ct%x00%B",
            &oid.to_hex(),
            "--",
        ],
    )
    .with_env(EnvProfile::ReadInteractive);
    let args = req.display_args();
    let out = runner.run(req).await?.ok(&args)?;
    let fields: Vec<&[u8]> = out.split(|&b| b == 0).collect();
    if fields.len() < 9 {
        return Err(mgit_model::ParseError::Truncated {
            fields_seen: fields.len(),
        }
        .into());
    }
    let lossy = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    let num = |b: &[u8]| lossy(b).trim().parse::<i64>().unwrap_or(0);
    Ok(CommitMeta {
        oid: Oid::from_hex(fields[0])?,
        parents: fields[1]
            .split(|&b| b == b' ')
            .filter(|p| !p.is_empty())
            .filter_map(|p| Oid::from_hex(p).ok())
            .collect(),
        author_name: lossy(fields[2]),
        author_email: lossy(fields[3]),
        author_time: num(fields[4]),
        committer_name: lossy(fields[5]),
        committer_email: lossy(fields[6]),
        committer_time: num(fields[7]),
        message: lossy(fields[8]).trim_end_matches('\n').to_string(),
    })
}

/// 커밋이 바꾼 파일 목록. 머지 커밋은 첫 부모 기준, 루트 커밋은 빈 트리 기준
pub async fn commit_files(
    runner: &dyn GitRunner,
    work_tree: &Path,
    oid: &Oid,
    has_parent: bool,
) -> Result<Vec<ChangedFile>, GitError> {
    let hex = oid.to_hex();
    let mut args: Vec<String> = vec![
        "diff-tree".into(),
        "-r".into(),
        "-M".into(),
        "-z".into(),
        "--name-status".into(),
        "--no-color".into(),
    ];
    if has_parent {
        args.push(format!("{hex}^"));
        args.push(hex);
    } else {
        args.push("--root".into());
        args.push(hex);
    }
    let req = GitRequest::new(work_tree, args)
        .with_config("core.quotepath", "false")
        .with_env(EnvProfile::ReadInteractive);
    let display = req.display_args();
    let out = runner.run(req).await?.ok(&display)?;
    Ok(parse_name_status(&out))
}

/// `--name-status -z` 출력: `<status>\0<path>\0`, 이름 변경·복사는 `<R|C><score>\0<old>\0<new>\0`.
/// `--root` 없이 커밋 하나를 주면 첫 줄에 커밋 해시가 올 수 있어 건너뛴다
pub fn parse_name_status(out: &[u8]) -> Vec<ChangedFile> {
    let mut fields: Vec<&[u8]> = out.split(|&b| b == 0).collect();
    if fields.last().is_some_and(|f| f.is_empty()) {
        fields.pop();
    }
    let mut files = Vec::new();
    let mut i = 0;
    while i < fields.len() {
        let status = fields[i];
        i += 1;
        // 해시 한 줄 (40 hex) 은 건너뛴다
        if status.len() == 40 && Oid::from_hex(status).is_ok() {
            continue;
        }
        let Some(&code) = status.first() else {
            continue;
        };
        let score: u8 = std::str::from_utf8(&status[1..])
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let lossy = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
        match code {
            b'R' | b'C' => {
                let (Some(old), Some(new)) = (fields.get(i), fields.get(i + 1)) else {
                    break;
                };
                i += 2;
                files.push(ChangedFile {
                    path: lossy(new),
                    old_path: Some(lossy(old)),
                    change: if code == b'R' {
                        DiffChange::Renamed { similarity: score }
                    } else {
                        DiffChange::Copied { similarity: score }
                    },
                });
            }
            _ => {
                let Some(path) = fields.get(i) else {
                    break;
                };
                i += 1;
                let change = match code {
                    b'A' => DiffChange::Added,
                    b'D' => DiffChange::Deleted,
                    b'T' => DiffChange::TypeChanged,
                    _ => DiffChange::Modified,
                };
                files.push(ChangedFile {
                    path: lossy(path),
                    old_path: None,
                    change,
                });
            }
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_status_with_renames() {
        let out = b"M\0a.txt\0R090\0old.txt\0new.txt\0A\0\xed\x95\x9c\xea\xb8\x80.txt\0D\0gone\0";
        let files = parse_name_status(out);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].change, DiffChange::Modified);
        assert_eq!(files[1].change, DiffChange::Renamed { similarity: 90 });
        assert_eq!(files[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!(files[1].path, "new.txt");
        assert_eq!(files[2].path, "한글.txt");
        assert_eq!(files[3].change, DiffChange::Deleted);
    }
}
