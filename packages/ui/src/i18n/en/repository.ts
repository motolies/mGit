import { formatNumber, plural } from '../../format';
import type { Strings } from '../../strings';

// 영어 사전: commit 상세·사이드바·메뉴·대화상자·원격·stash·worktree·홈·복제·폴더·서브모듈·충돌 구역 (ko.ts 의 같은 구역과 키가 같다)
export const enRepository: Pick<
  Strings,
  | 'detail'
  | 'sidebar'
  | 'menu'
  | 'dialog'
  | 'op'
  | 'search'
  | 'quickSwitch'
  | 'commitGraph'
  | 'remote'
  | 'tag'
  | 'stash'
  | 'worktree'
  | 'home'
  | 'clone'
  | 'init'
  | 'folder'
  | 'submodule'
  | 'conflict'
> = {
  detail: {
    author: 'Author',
    parents: 'Parents',
    children: 'Children',
    files: (n: number) => `${formatNumber(n)} changed ${plural(n, 'file', 'files')}`,
    loading: 'Loading…',
    // Git 도구 창 오른쪽의 변경 파일 트리와 상세 (CD-01·02·06)
    changedFiles: 'Changed files',
    fileCount: (n: number) => `${formatNumber(n)} ${plural(n, 'file', 'files')}`,
    pickCommit: 'Select a commit in the log to see its changed files and details',
    failed: (message: string) => `Couldn't load commit details: ${message}`,
    retry: 'Retry',
    resize: 'Resize changed files and details',
    // 작성자 줄 뒤의 커밋한 사람·시각 (작성과 다를 때)
    committed: (name: string, date: string) => `Committed by ${name} · ${date}`,
    copyHash: 'Copy hash',
    copied: 'Copied',
    noFiles: 'No changed files',
    // 상세 아래의 "이 commit 을 포함하는 branch" 줄 (CD-03). 개수는 맨 앞의 HEAD 를 포함한다
    containing: (n: number) => `In ${formatNumber(n)} ${plural(n, 'branch', 'branches')}:`,
    containingList: 'Branches containing this commit',
    containingLoading: 'Loading containing branches…',
    containingNone: 'Not in any branch',
    containingMore: (n: number) => `+${formatNumber(n)} more`,
    containingLess: 'Show less',
    containingTimedOut: 'Took too long to load containing branches',
    containingFailed: (message: string) => `Couldn't load containing branches: ${message}`,
    rangeTitle: (n: number) => `Range of ${formatNumber(n)} ${plural(n, 'commit', 'commits')}`,
    rangeHint: '⇧+click to change the range. Combined diff, excluding ancestors outside the range.',
    rangeClear: 'Clear range',
    rangeRoot: '(from root)',
    signature: 'Signature',
    signatureCode: (code: string) => {
      switch (code) {
        case 'G':
          return 'Valid';
        case 'B':
          return 'Bad';
        case 'U':
          return 'Valid (unknown trust)';
        case 'X':
        case 'Y':
          return 'Expired';
        case 'R':
          return 'Revoked key';
        case 'E':
          return "Can't verify";
        default:
          return 'None';
      }
    },
  },
  sidebar: {
    tags: 'Tags',
    worktrees: 'Worktrees',
    current: 'Current',
    gone: 'Remote gone',
    checkedOutAt: (path: string) => `Checked out at ${path}`,
    main: 'Main',
    detached: 'detached',
    locked: 'Locked',
    prunable: 'Folder missing',
    noUpstream: 'No upstream',
    origin: (path: string) => `Worktree: ${path}`,
  },
  menu: {
    checkout: 'Checkout',
    checkoutDetached: 'Check out this commit (detached)',
    createBranchHere: 'Create branch here…',
    createTagHere: 'Create tag here…',
    createWorktreeHere: 'Create worktree here…',
    rebaseInteractive: 'Interactive rebase from here to HEAD…',
    reword: 'Edit message…',
    squashIntoParent: 'Squash into parent',
    squashIntoParentTitle: (hash: string) => `Squash ${hash} into its parent commit?`,
    squashIntoParentMessage:
      "This commit's changes go into its parent, and the parent's message is kept. Later commits are rewritten.",
    squashRange: (n: number) => `Squash ${n} selected commits into one…`,
    cherryPick: 'Cherry-pick',
    revert: 'Revert',
    reset: 'Reset',
    resetSoft: 'Soft (keep changes staged)',
    resetMixed: 'Mixed (keep changes in working tree)',
    resetHard: 'Hard (discard all changes)',
    rebaseOnto: 'Rebase current branch onto here',
    mergeInto: (name: string) => `Merge ${name} into current branch`,
    mergeIntoNoFf: 'Merge (--no-ff)',
    mergeIntoFfOnly: 'Merge (--ff-only)',
    mergeIntoSquash: 'Merge (--squash)',
    rebaseCurrentOnto: (name: string) => `Rebase current branch onto ${name}`,
    copyHash: 'Copy hash',
    copySubject: 'Copy subject',
    copyPath: 'Copy path',
    copyName: 'Copy name',
    rename: 'Rename…',
    delete: 'Delete…',
    deleteRemote: 'Delete from remote…',
    setUpstream: 'Set upstream…',
    unsetUpstream: 'Unset upstream',
    selectRange: 'Select range from selected commit to here',
    showDiff: 'Show diff',
    blame: 'Blame…',
    fileHistory: 'File history…',
    difftool: 'Open in external diff tool',
    graphSolo: 'Show only this branch in graph',
    compareWithHead: (name: string) => `Compare ${name} with current branch…`,
    mergePreview: (name: string) => `Preview merge of ${name}…`,
    rebasePreview: (name: string) => `Preview rebase onto ${name}…`,
    rebasePreviewHere: 'Preview rebase of current branch onto here…',
    isolatedMerge: (name: string) => `Isolated merge of ${name}…`,
    remergeDiff: 'Merge resolution diff (remerge-diff)…',
  },
  dialog: {
    nestedRepo: 'Unregistered nested repository',
    nestedRepoMessage: (paths: string) =>
      `Found .git inside ${paths}. Staging it as is adds only a pointer without contents. Add it as a submodule or add it to .gitignore.`,
    nestedRepoAdopt: 'Add as submodule',
    nestedRepoIgnore: 'Add to .gitignore',
    submoduleUnpushed: 'Submodule has unpushed commits',
    submoduleUnpushedMessage: (items: string) =>
      `${items} — if you push only the superproject, others won't be able to get those commits.`,
    submoduleUnpushedFirst: 'Push submodules first',
    submoduleUnpushedAnyway: 'Push anyway',
    reapplyTitle: 'Saved resolutions found',
    reapplyMessage: (n: number) =>
      `Reapply the results for ${formatNumber(n)} ${plural(n, 'file', 'files')} you resolved earlier in the same operation?`,
    reapplyYes: 'Reapply',
    syntaxTitle: 'New syntax errors introduced',
    syntaxMessage: (n: number, line: number | null, lang: string) =>
      `Parsing as ${lang} found ${formatNumber(n)} ${plural(n, 'error', 'errors')}${line ? ` (first on line ${line})` : ''}. Neither original side had these errors. Save anyway?`,
    syntaxSaveAnyway: 'Save anyway',
    tagSign: 'Signed tag (-s)',
    createBranch: 'New branch',
    branchName: 'Branch name',
    startPoint: 'Start point',
    checkoutAfter: 'Check out after creating',
    renameBranch: 'Rename branch',
    newName: 'New name',
    deleteBranch: (name: string) => `Delete branch '${name}'?`,
    deleteBranchMessage:
      'The local branch will be deleted. Commits not yet pushed will remain only in the reflog.',
    deleteBranchForce: (name: string) => `'${name}' is not merged yet. Force delete it?`,
    deleteBranchForceMessage:
      'It has unmerged commits. Once deleted, they disappear from the graph and can only be recovered from the reflog.',
    deleteRemoteBranch: (remote: string, name: string) =>
      `Delete branch '${name}' from remote ${remote}?`,
    deleteRemoteBranchMessage: 'Others may be using this branch.',
    createTag: 'New tag',
    tagName: 'Tag name',
    tagMessage: 'Message (makes an annotated tag)',
    deleteTag: (name: string) => `Delete tag '${name}'?`,
    setUpstream: 'Set upstream',
    upstreamName: 'Upstream (e.g. origin/main)',
    resetHard: (target: string) => `Hard reset to ${target}?`,
    resetHardMessage:
      "All staged and working tree changes will be lost. Uncommitted changes can't be recovered.",
    dirtyCheckout: 'You have local changes',
    dirtyCheckoutMessage:
      'Switching would overwrite some files. Stash your changes, switch, and reapply them, or cancel the switch.',
    stashAndSwitch: 'Stash and switch',
    remoteBranchTaken: (local: string) => `Local branch ${local} already exists`,
    remoteBranchTakenMessage: (local: string, upstream: string | null, target: string) =>
      upstream
        ? `Local ${local} tracks ${upstream}, so you can't switch to ${target} directly. Create a tracking branch with a different name, or check out a detached HEAD.`
        : `Local ${local} has no upstream, so it's unclear whether it belongs to ${target}. Create a tracking branch with a different name, or check out a detached HEAD.`,
    createTracking: 'Create tracking branch',
    checkoutDetached: 'Check out detached HEAD',
    branchElsewhere: 'In use by another worktree',
    branchElsewhereMessage: (path: string) =>
      `This branch is checked out at ${path}, so you can't switch to it here. Use "Open worktree" to open that tab.`,
    openWorktree: 'Open worktree',
    nonFastForward: 'Remote has new commits',
    nonFastForwardMessage:
      'Push was rejected. Pull to integrate the remote changes and then push, or push with force-with-lease to overwrite them.',
    pullThenPush: 'Pull, then push',
    forcePush: 'Push with force-with-lease',
    staleInfo: 'Force push was rejected',
    staleInfoMessage:
      "The remote changed since your last fetch. Stopped to avoid overwriting others' commits. Pull, review the changes, then push again.",
    staleInfoPull: 'Pull',
    upstreamMismatch: 'Upstream branch name differs from local',
    upstreamMismatchMessage: (local: string, remote: string, upstream: string) =>
      `Pushing local ${local} to ${remote}/${upstream}. Is this the intended target?`,
    upstreamMismatchRemember: "Don't ask again for this branch",
    upstreamMismatchConfirm: 'Push',
    conflictMarkers: 'Conflict markers remain',
    conflictMarkersMessage:
      'The files below contain conflict markers. If the markers are meant to be content, go ahead.',
    conflictMarkersCommit: 'Commit anyway',
    conflictMarkersContinue: 'Continue anyway',
    conflictMarkersSave: 'Save anyway',
    closeWithDrafts: (name: string) => `Close the ${name} tab?`,
    closeWithDraftsMessage:
      "You have unsaved conflict edits. They'll be lost if you close the tab.",
    closeWithDraftsConfirm: 'Close',
    restoreOtherBranchMessage:
      "Moves this branch to the backup point. It isn't checked out, so the working tree doesn't change.",
    indexLock: 'index.lock is still present',
    indexLockMessage:
      "Another git process may have exited abnormally and left the lock file behind. If no other git command is running, it's safe to delete.",
    removeLock: 'Delete lock file',
    detachedHead: 'Detached HEAD',
    detachedHeadMessage:
      "The current commit doesn't belong to any branch. Create a branch here to keep your work.",
    noUpstream: 'No upstream',
    noUpstreamMessage:
      "This branch isn't linked to a remote branch. Push it under the same name and set the upstream?",
    pushSetUpstream: 'Push and set upstream',
    hookFailed: 'Rejected by a hook',
    hookFailedMessage:
      'Check the hook output. If you know the cause, you can skip hooks and try again.',
    retryNoVerify: 'Skip hooks and commit',
    nothingToCommit: 'Nothing to commit',
    nothingToCommitMessage: 'Stage files first.',
    delete: 'Delete',
    create: 'Create',
    apply: 'Apply',
    rename: 'Rename',
  },
  op: {
    continueLabel: 'Continue',
    skip: 'Skip',
    abort: 'Abort',
    conflicts: (n: number) =>
      `${formatNumber(n)} conflicted ${plural(n, 'file', 'files')} — resolve, stage, then Continue`,
    noConflicts: 'All conflicts resolved. Click Continue to proceed',
    abortTitle: 'Abort the operation in progress?',
    abortMessage: 'Conflict resolutions made so far will be discarded.',
    abortKept: (n: number) =>
      `The ${formatNumber(n)} resolved ${plural(n, 'file is', 'files are')} kept, and you'll be offered to reapply them if you restart the same operation.`,
    outcomeClean: 'Done',
  },
  search: {
    placeholder: 'Search message, author, hash',
    count: (cursor: number, total: number) => `${total === 0 ? 0 : cursor + 1} / ${total}`,
    truncated: '(partial results)',
    next: 'Next',
    prev: 'Previous',
    close: 'Close',
    advanced: 'Advanced',
    author: 'Author',
    path: 'Path',
    pickaxe: 'Code change (-S)',
    pickaxeRegex: 'Regex (-G)',
    since: 'Since',
    until: 'Until',
    run: 'Search',
  },
  quickSwitch: {
    title: 'Switch branch',
    placeholder: 'Type a branch name…',
    empty: 'No matching branches',
  },
  commitGraph: {
    suggest: 'This repository has many commits. Writing a commit-graph speeds up graph loading.',
    write: 'Write commit-graph',
    writing: 'Writing…',
    dismiss: 'Dismiss',
  },
  remote: {
    fetch: 'Fetch',
    pull: 'Pull',
    push: 'Push',
    pushMenu: 'Choose push target',
    pushUpstream: (upstream: string) => `Push to ${upstream} (upstream)`,
    pushNoUpstream: (remote: string) => `No upstream — push to ${remote} and set it`,
    pushTo: (remote: string) => `Push to ${remote}`,
    pushToSetUpstream: (remote: string) => `Push to ${remote} and set upstream`,
    fetchOnly: (remote: string) => `Fetch ${remote} only`,
    remotes: 'Remotes…',
    pullMode: {
      default: 'pull (per config)',
      merge: 'pull --no-rebase',
      rebase: 'pull --rebase',
      ffOnly: 'pull --ff-only',
    },
    dialogTitle: 'Remotes',
    empty: 'No remotes',
    add: 'Add…',
    addTitle: 'Add remote',
    name: 'Name',
    url: 'URL',
    rename: 'Rename…',
    setUrl: 'Change URL…',
    remove: 'Remove…',
    removeTitle: (name: string) => `Remove remote '${name}'?`,
    removeMessage: 'Its remote-tracking branches will be deleted too.',
    pushUrl: (url: string) => `push: ${url}`,
    close: 'Close',
  },
  tag: {
    pushMenu: 'Push',
    pushNoRemote: 'Push (no remotes)',
    logItem: (name: string) => `Tag ${name}`,
    pushed: (name: string, remote: string) => `Pushed tag ${name} to ${remote}`,
    pushedMany: (n: number, remote: string) =>
      `Pushed ${formatNumber(n)} ${plural(n, 'tag', 'tags')} to ${remote}`,
    upToDate: (name: string, remote: string) => `Tag ${name} is already on ${remote}`,
    pushFailed: (remote: string, details: string) =>
      `Couldn't push these tags to ${remote}: ${details}`,
    status: {
      diverged: 'differs from the local tag',
      rejectedExists: 'a different tag with this name exists on the remote',
      rejectedStale: 'the remote changed in the meantime',
      failed: 'failed',
      unknown: 'result unknown — check the remote again',
      notProcessed: 'not processed',
      notRun: 'awaiting confirmation',
    },
    fetched: (name: string, remote: string, overwrite: boolean) =>
      overwrite
        ? `Replaced tag ${name} with the one on ${remote}`
        : `Fetched tag ${name} from ${remote}`,
    fetchedMany: (n: number, remote: string) =>
      `Fetched ${formatNumber(n)} ${plural(n, 'tag', 'tags')} from ${remote}`,
    fetchFailed: (remote: string, details: string) =>
      `Couldn't fetch these tags from ${remote}: ${details}`,
    fetchRecheck: (remote: string) =>
      `Nothing was fetched because some tags aren't on ${remote}. Check the remote and try again.`,
    exists: {
      title: (name: string, remote: string) => `A different tag named ${name} exists on ${remote}`,
      titleMany: (n: number, remote: string) =>
        `${remote} has ${formatNumber(n)} different ${plural(n, 'tag', 'tags')} with the same ${plural(n, 'name', 'names')}`,
      message:
        "The local tag wasn't pushed because the remote has a different tag with the same name. Nothing was changed.",
      replace: 'Overwrite remote tag with local…',
    },
    align: {
      toRemote: 'Match remote…',
      toLocal: 'Match local…',
      toRemoteTitle: (name: string, remote: string) =>
        `Replace local tag ${name} with the one on ${remote}?`,
      toRemoteMessage:
        'The local tag will point to the same object as the remote tag. You can undo this with ↶ Undo.',
      toRemoteConfirm: 'Use remote tag',
      toLocalTitle: (n: number, remote: string) =>
        n === 1
          ? `Overwrite the tag on ${remote} with the local one?`
          : `Overwrite ${formatNumber(n)} tags on ${remote} with the local ones?`,
      toLocalMessage:
        "Repositories that already fetched the old tag keep it. This can't be undone.",
      toLocalConfirm: 'Overwrite with local',
    },
    replaced: (name: string, remote: string) =>
      `Overwrote tag ${name} on ${remote} with the local one`,
    replacedMany: (n: number, remote: string) =>
      `Overwrote ${formatNumber(n)} ${plural(n, 'tag', 'tags')} on ${remote} with the local ${plural(n, 'one', 'ones')}`,
    replaceFailed: (remote: string, details: string) =>
      `Couldn't overwrite these tags on ${remote}: ${details}`,
    del: {
      title: (name: string) => `Delete tag '${name}'`,
      titleMany: (n: number) => `Delete ${formatNumber(n)} ${plural(n, 'tag', 'tags')}`,
      message:
        'Tags are deleted from the chosen remotes first. A local tag is deleted only if it was deleted from every chosen remote.',
      comeBackMaybe:
        "Tags deleted only locally may come back on the next fetch if they're still on a remote.",
      scope: 'Delete from',
      local: 'Local',
      localNote: 'can be restored with ↶ Undo',
      remoteNote: "can't be undone",
      applies: (n: number) => `${formatNumber(n)} affected`,
      notChecked: 'not checked',
      absent: 'not on this remote',
      notLocal: 'not local',
      comeBack: (n: number) =>
        `${formatNumber(n)} ${plural(n, 'tag', 'tags')} deleted only locally ${plural(n, 'is', 'are')} still on a remote and may come back on the next fetch.`,
      unpushedWarn: (n: number) =>
        `${formatNumber(n)} unpushed ${plural(n, 'tag is', 'tags are')} not on any remote. Once deleted, only ↶ Undo can restore ${plural(n, 'it', 'them')}.`,
      none: 'Choose at least one place to delete from',
      localUndo: 'You can restore it with ↶ Undo.',
      done: (name: string, places: string) => `Deleted tag ${name} (${places})`,
      doneMany: (n: number, places: string) =>
        `Deleted ${formatNumber(n)} ${plural(n, 'tag', 'tags')} (${places})`,
      remoteFailed: (remote: string, details: string) => `${remote}: ${details}`,
      cancelled: 'Canceled in the confirmation, so the rest was not deleted',
      localKept: (names: string) => `Kept locally: ${names}`,
      localFailed: (reason: string) => `Local delete failed: ${reason}`,
    },
    differs: {
      title: (remote: string, n: number) =>
        n === 1
          ? `The tag on ${remote} differs from the local one`
          : `${formatNumber(n)} tags on ${remote} differ from the local ones`,
      message:
        "The remote tag points to a different object than the local one. Deleting it from the remote can't be undone.",
      item: (name: string, remote: string, local: string) =>
        `${name} — remote ${remote} · local ${local}`,
      itemSameCommit: (name: string, commit: string) =>
        `${name} — same commit ${commit}, different tag object`,
      skip: 'Skip these and delete the rest',
      deleteAnyway: 'Delete from remote anyway',
    },
    check: {
      action: 'Check remote tags',
      failed: {
        auth: 'Authentication failed',
        network: 'Connection failed',
        other: 'Check failed',
      },
    },
    state: {
      localOnly: 'not pushed',
      remoteOnly: 'remote only',
      same: 'same',
      diverged: 'differs',
      divergedSameCommit: 'differs (same commit, different tag object)',
      unknown: 'unknown',
      notChecked: 'not checked',
      line: (remote: string, state: string) => `${remote}: ${state}`,
    },
    tree: {
      unpushed: 'not pushed',
      differs: 'differs',
      summaryUnpushed: (n: number) => `${formatNumber(n)} not pushed`,
      summaryRemoteOnly: (n: number) => `${formatNumber(n)} remote only`,
      summaryDiffers: (n: number) => `${formatNumber(n)} ${plural(n, 'differs', 'differ')}`,
      summarySame: 'same as remote',
      stale: 'outdated',
      checking: 'Checking…',
    },
    doc: {
      title: 'Tags',
      open: 'Manage tags',
      remote: 'Compare with remote',
      noRemote: 'No remotes to compare with',
      check: 'Check remote',
      checking: 'Checking…',
      notChecked: 'Not checked — click Check remote to compare',
      checkedAt: (time: string) => `Checked ${time}`,
      search: 'Search tags',
      filters: 'State filters',
      filter: {
        all: 'All',
        localOnly: 'Local only',
        remoteOnly: 'Remote only',
        same: 'Same',
        diverged: 'Differs',
      },
      filterCount: (label: string, n: number) => `${label} ${formatNumber(n)}`,
      list: 'Tags',
      columns: {
        name: 'Name',
        kind: 'Kind',
        localCommit: 'Local commit',
        remoteCommit: 'Remote commit',
        state: 'State',
        date: 'Date',
      },
      tagger: (who: string) => `Tagger: ${who}`,
      fetch: 'Fetch',
      kind: {
        annotated: 'Annotated',
        lightweight: 'Lightweight',
      },
      stateNotChecked: '—',
      empty: {
        noTags: 'No tags',
        noMatch: 'No tags match',
      },
      selected: (n: number) => `${formatNumber(n)} selected`,
      showInLog: 'Show in log',
    },
    batch: {
      label: 'Tag actions',
      push: (remote: string, n: number) => `Push to ${remote} (${formatNumber(n)})`,
      fetch: (n: number) => `Fetch (${formatNumber(n)})`,
      del: (n: number) => `Delete… (${formatNumber(n)})`,
      slow: 'With this many tags, this may take a few minutes. You can cancel while it runs.',
    },
    result: {
      summary: (title: string, ok: number, failed: number) =>
        failed === 0
          ? `${title}: ${formatNumber(ok)} done`
          : `${title}: ${formatNumber(ok)} done, ${formatNumber(failed)} left`,
      push: (remote: string) => `Push to ${remote}`,
      fetch: (remote: string) => `Fetch from ${remote}`,
      toRemote: (remote: string) => `Match ${remote}`,
      toLocal: (remote: string) => `Overwrite ${remote} with local`,
      del: 'Delete',
      localKept: 'kept locally',
      list: 'Remaining tags',
      retry: 'Retry failed',
      close: 'Close results',
    },
    pushAll: 'Push all tags…',
    pushAllTo: (remote: string) => `Push all tags to ${remote}…`,
    showRemoteOnly: (n: number) =>
      `Show ${formatNumber(n)} remote-only ${plural(n, 'tag', 'tags')}`,
  },
  stash: {
    save: 'Stash changes…',
    saveTitle: 'Stash changes',
    message: 'Message (optional)',
    includeUntracked: 'Include untracked files',
    stagedOnly: 'Staged changes only (--staged)',
    apply: 'Apply',
    pop: 'Pop (apply and drop)',
    drop: 'Drop…',
    dropTitle: (name: string) => `Drop ${name}?`,
    dropMessage: "A dropped stash can't be recovered.",
    gone: 'This stash no longer exists. Check the list',
    show: 'Show contents',
    title: 'Stash details',
    files: (n: number) => `${formatNumber(n)} changed ${plural(n, 'file', 'files')}`,
    untracked: 'Includes untracked',
    name: (i: number) => `stash@{${i}}`,
    // Commit 도구 창 Stash 탭 (W23): 목록 이름, 상세의 항목 이름, 빈 상태
    list: 'Stash list',
    branchLabel: 'Branch',
    originLabel: 'Path',
    empty: 'No stashes',
    pick: 'Select a stash to see its contents',
  },
  worktree: {
    create: 'Create worktree…',
    createTitle: 'New worktree',
    branchName: 'New branch name',
    pathTitle: 'Worktree path',
    path: 'Path',
    pathMessage: (branch: string) => `Folder where branch '${branch}' will be checked out.`,
    open: 'Open',
    remove: 'Delete…',
    removeTitle: (path: string) => `Delete worktree ${path}?`,
    removeDirty: "There are uncommitted changes. They'll be lost if you delete it.",
    removeUnpushed: (n: number) =>
      `${plural(n, 'There is', 'There are')} ${formatNumber(n)} unpushed ${plural(n, 'commit', 'commits')}.`,
    removeNoUpstream: "There's no upstream, so it's unknown whether everything was pushed.",
    removeClean: 'The folder will be deleted. The branch is kept.',
    deleteBranchToo: (b: string) => `Also delete branch '${b}'`,
    prune: 'Prune missing worktrees',
    created: (path: string) => `Worktree created: ${path}`,
  },
  home: {
    browseRemote: 'Remote repositories…',
    title: 'Start',
    open: 'Open repository…',
    clone: 'Clone…',
    init: 'New repository…',
    scan: 'Scan folder…',
    scanTitle: 'Choose a folder to scan for repositories',
    recent: 'Recent',
    search: 'Search recent',
    empty: 'No recently opened repositories',
    pin: 'Pin',
    unpin: 'Unpin',
    remove: 'Remove from list',
    folder: 'Folder',
    dropHint: 'You can also drop a folder here',
  },
  clone: {
    depth: 'Depth (empty = full)',
    depthPlaceholder: 'e.g. 1',
    blobless: 'Fetch file contents on demand (--filter=blob:none)',
    singleBranch: 'Single branch only (--single-branch)',
    title: 'Clone repository',
    url: 'URL or path',
    parent: 'Location (parent folder)',
    name: 'Folder name',
    branch: 'Branch (optional)',
    recurse: 'Include submodules (--recurse-submodules)',
    button: 'Clone',
    running: (label: string) => `${label}…`,
    pickParent: 'Choose the parent folder to clone into',
  },
  init: {
    title: 'New repository',
    name: 'Folder name',
    branch: 'Default branch',
    template: '.gitignore template',
    none: 'None',
    pickParent: 'Choose the parent folder for the new repository',
    button: 'Create',
  },
  folder: {
    title: (name: string) => `${name} dashboard`,
    repos: (n: number) => `${formatNumber(n)} ${plural(n, 'repository', 'repositories')}`,
    refresh: 'Refresh',
    rescan: 'Rescan',
    filter: {
      all: 'All',
      changed: 'Changed',
      behind: 'Behind',
      inProgress: 'In progress',
    },
    columns: {
      name: 'Repository',
      kind: 'Type',
      branch: 'Branch',
      changed: 'Changes',
      sync: 'Ahead/behind',
      op: 'In progress',
      lastFetch: 'Last fetch',
    },
    kind: {
      standalone: '',
      worktree: 'Worktree',
      submodule: 'Submodule',
    },
    never: 'Never',
    empty: 'No repositories in this folder',
    openHint: 'Double-click to open',
    // 개요 표의 체크박스 (프로젝트 트리 선택과 한 상태, PT-07)
    selectAll: 'Select all visible repositories',
    selectRepo: (name: string) => `Select ${name}`,
    refreshedAt: (t: string) => `Updated ${t}`,
    // 개요 탭에서 Commit 도구 창을 여는 진입점 (W14: 통합 변경 보기가 Commit 도구 창으로 옮겨 갔다)
    openCommitTool: 'Open Commit tool window',
    timeline: {
      branchesTooNarrow: 'Branch list collapsed because the tool window is narrow',
      resizeBranches: 'Resize branch list',
      hideRemotes: 'Hide remotes',
      rows: (n: number) => `${formatNumber(n)} ${plural(n, 'commit', 'commits')}`,
      // 필터(텍스트·branch·작성자·날짜·저장소 범위)가 걸린 결과의 행 수
      matched: (n: number) => `${formatNumber(n)} ${plural(n, 'match', 'matches')}`,
      truncated: (n: number) => `Showing latest ${formatNumber(n)} per repository`,
      // 필터가 걸렸을 때의 잘림: 걸러진 결과가 저장소당 상한을 넘었다 (W16 계약)
      truncatedFiltered: (n: number) =>
        `Over ${formatNumber(n)} matching commits per repository; showing latest ${formatNumber(n)}`,
      truncatedRepos: (names: string) => `Truncated repositories: ${names}`,
      openInRepo: 'Open in repository tab',
      // 행 우클릭 (LG-09): 그 행의 저장소 하나로 범위를 좁힌다 / 이미 그 저장소만 보고 있으면 범위를 푼다
      onlyThisRepo: 'Show only this repository',
      allRepos: 'Show all repositories',
      resizeDetail: 'Resize changed files and details',
      empty: 'No commits',
      // 필터 결과 없음 상태 (LG-11): 건 조건을 보이고 한 번에 지우는 단추
      noMatch: 'No commits match the filters',
      clearFilters: 'Clear filters',
      loading: 'Loading…',
      failed: (msg: string) => `Couldn't load the timeline: ${msg}`,
      retry: 'Retry',
      // 일부 저장소 실패 (LG-11): 나머지 저장소의 로그는 그대로 보인다
      partialFailed: (n: number, names: string) =>
        `Couldn't load ${formatNumber(n)} ${plural(n, 'repository', 'repositories')}: ${names}`,
      // 로그 밖에서 고른 커밋(blame·히스토리 해시, 상세의 부모)이 지금 로그에 없을 때 (W19). 상세는 그대로 보인다
      revealFiltered: "The selected commit isn't in the log with the current filters",
      revealAbsent: "The selected commit isn't in the current log",
      revealAbsentTitle:
        'It may be missing because of view options (first parent only, no merges) or the per-repository commit limit',
      revealClear: 'Clear filters and show',
      inRepos: (names: string) => `(${names})`,
      // 브랜치 트리로 건 로그 범위 (BT-03)
      moreBranches: (first: string, more: number) => `${first} +${formatNumber(more)} more`,
      // 브랜치 트리의 checkout (BT-07): 대상 저장소를 체크 목록으로 확인받는다
      checkoutTitle: (name: string) => `Checkout: ${name}`,
      checkoutTargets: (n: number) =>
        `Of the ${formatNumber(n)} ${plural(n, 'repository', 'repositories')} with this branch, checks out in the checked ones`,
      checkoutTracking:
        "A remote branch is checked out as the same-named local branch tracking this remote. If there's no local branch, one is created. Repositories whose same-named local branch doesn't track this remote are skipped",
      // 브랜치 트리의 "여기서 새 branch…": 그 브랜치를 시작점으로 만든다. 대상 저장소를 체크 목록으로 확인받는다
      newBranchFromTitle: (start: string) => `New branch from ${start}`,
      newBranchFromTargets: (n: number) =>
        `Of the ${formatNumber(n)} ${plural(n, 'repository', 'repositories')} with this branch, creates it in the checked ones`,
      checkoutCurrent: (repo: string) => `${repo} (current branch)`,
      batchFailed: "Couldn't run the batch operation",
    },
    batch: {
      selected: (n: number) => `${formatNumber(n)} selected`,
      allRepos: (n: number) => `All ${formatNumber(n)}`,
      // 확인창과 툴팁에 쓰는 대상 표기: 수와 저장소 이름
      targets: (scope: string, names: string) => `${scope}: ${names}`,
      withScope: (label: string, scope: string) => `${label} (${scope})`,
      none: 'Clear selection',
      fetch: 'Fetch',
      pull: 'Pull',
      push: 'Push',
      branch: 'Create branch…',
      checkout: 'Checkout…',
      worktree: 'Create worktree…',
      branchTitle: 'Create branch in each selected repository',
      branchName: 'Branch name',
      branchCheckout: 'Check out after creating',
      checkoutTitle: 'Check out in each selected repository',
      worktreeTitle: 'Create worktree in each repository',
      worktreeBranch: 'Branch',
      worktreeRoot: 'Worktree folder (subfolder per repository name)',
      worktreeCreate: 'Create with new branch',
      // 일괄 push 체크 목록 (WS-09, W14·W19): 올라갈 commit 이 있는 저장소만 체크할 수 있고, 체크한 저장소에만 push
      // 한다. 건너뛸 저장소는 같은 목록에 꺼진 칸과 사유로 보인다 (코어의 건너뛰기 규칙을 미리 보인다)
      pushTitle: 'Push current branch to upstream in each repository',
      pushMessage: (scope: string) => `${scope}. Pushes only to checked repositories`,
      pushNone: 'No repositories have commits to push',
      pushCommits: (name: string, n: number) =>
        `${name}: ${formatNumber(n)} ${plural(n, 'commit', 'commits')}`,
      pushSkip: (name: string, why: string) => `${name}: skipped (${why})`,
      pushUnknown: (name: string) => `${name}: status not known yet (checked on run)`,
      // 꺼진 칸의 사유 (요약을 아직 못 읽었거나 읽지 못한 저장소)
      unknownState: 'Status not known yet',
      noUpstream: 'No upstream',
      nothingToPush: 'No commits to push',
      excluded: 'Excluded (folder settings)',
      // 저장소 체크 목록의 묶음 제목과, 하나도 체크하지 않았을 때 확인을 끄는 사유 (W19 — push·checkout·새 branch)
      repoGroup: (n: number) =>
        `${formatNumber(n)} target ${plural(n, 'repository', 'repositories')}`,
      noneChecked: 'No repositories checked',
      // 일괄 pull 의 툴팁: 방식과 건너뛰는 저장소
      pullTip: (mode: string) =>
        `${mode} · Skips repositories with uncommitted changes, an operation in progress, or no upstream`,
      running: (label: string, phase: string) => (phase ? `${label}: ${phase}` : label),
      result: (s: number, k: number, f: number) =>
        `${formatNumber(s)} succeeded · ${formatNumber(k)} skipped · ${formatNumber(f)} failed`,
      close: 'Close',
      openWorktrees: 'Open the created worktree folders?',
      ok: 'Done',
      skipped: 'Skipped',
      failed: 'Failed',
    },
    settings: {
      // 폴더 설정 대화상자 (W12: 개요의 설정 보기를 옮겼다)
      title: 'Folder settings',
      open: 'Folder settings…',
      close: 'Close',
      exclude: 'Repositories to exclude from batch operations (comma-separated)',
      pullMode: 'Batch pull mode',
      ffOnly: 'ff-only (safe)',
      rebase: 'rebase',
      merge: 'merge',
      concurrency: 'Parallel jobs (1–16)',
      autoRefresh: 'Auto-refresh interval (seconds, 0 = off)',
      worktreeRoot: 'Default worktree folder',
      save: 'Save',
      saved: 'Saved',
    },
  },
  submodule: {
    superproject: '↑ Superproject',
    updateRecursive: 'Update recursively',
    open: 'Open',
    updateRemote: 'Update to latest tracking branch (update --remote)',
    setBranch: 'Set tracking branch…',
    setBranchTitle: (p: string) => `Tracking branch for ${p}`,
    setBranchHint: 'Leave empty to unset the tracking branch (defaults to HEAD)',
    branch: 'Branch',
    remove: 'Remove…',
    removeTitle: (p: string) => `Remove submodule ${p}?`,
    removeMessage:
      'Removes it in order: deinit → rm → delete .git/modules. The removal is staged; commit it yourself.',
    removeConfirm: 'Remove',
    add: 'Add submodule…',
    addTitle: 'Add submodule',
    url: 'URL',
    path: 'Path',
    sync: 'Sync URLs (sync)',
    batch: 'Batch fetch/pull/push…',
    batchTitle: 'Submodule batch operation',
    batchOp: 'Operation',
    batchPrune: '--prune on fetch',
    pointerLog: (n: number) => `${formatNumber(n)} submodule ${plural(n, 'commit', 'commits')}`,
    pointerReversed: '(rolled back)',
    pointerMissing:
      "Can't build the list because the submodule doesn't have that commit (update needed)",
    sides: { base: 'base', ours: 'ours', theirs: 'theirs' },
    status: {
      notInitialized: 'Not initialized',
      clean: '',
      mismatch: 'Commit differs',
      dirty: 'Modified',
      conflict: 'Conflict',
    },
  },
  conflict: {
    title: 'Resolve conflicts',
    remaining: (n: number) =>
      n === 0
        ? 'No conflicts left'
        : `${formatNumber(n)} ${plural(n, 'conflict', 'conflicts')} left`,
    prev: 'Previous',
    next: 'Next',
    allOurs: 'All ours',
    allTheirs: 'All theirs',
    // 충돌 블록 위 버튼 줄 (CF-08): 양쪽을 다 넣기(ours 먼저·theirs 먼저), 고른 것을 미해결로 되돌리기
    pickBoth: 'Both',
    pickBothReversed: 'Both (reversed)',
    pickUndo: 'Unresolve',
    hideBase: 'Hide base',
    markersLeft: (lines: readonly number[]) =>
      `Conflict markers remain (${plural(lines.length, 'line', 'lines')} ${lines.slice(0, 5).join(', ')})`,
    save: 'Save and stage',
    saveDirty: 'Save and stage *',
    saveAnyway: 'Save anyway',
    draftRestored: 'Restored your in-progress edits',
    discardDraft: 'Start over',
    externallyResolved: (path: string) =>
      `The conflict in ${path} was resolved externally, so your unsaved edits were discarded`,
    // 이 세션의 작업 명령으로 충돌이 사라져 초안을 버렸을 때 (W19 — 사유를 "밖에서 해결" 과 가른다)
    droppedByAbort: (path: string) =>
      `The operation was aborted, so your unsaved edits to ${path} were discarded`,
    droppedBySkip: (path: string) =>
      `The commit was skipped, so your unsaved edits to ${path} were discarded`,
    droppedByContinue: (path: string) =>
      `Continuing the operation cleared the conflict in ${path}, so your unsaved edits were discarded`,
    result: 'Result',
    back: 'Back to list',
    continueTitle: 'You have in-progress edits',
    continueMessage:
      "The working tree file differs from git's automatic merge result. Keep editing it, or start over?",
    continueYes: 'Keep editing',
    continueFresh: 'Start over',
    kind: {
      bothModified: 'Both modified',
      bothAdded: 'Both added',
      bothDeleted: 'Both deleted',
      addedByUs: 'Added by us',
      addedByThem: 'Added by them',
      deletedByUs: 'Deleted by us',
      deletedByThem: 'Deleted by them',
    },
    binary:
      "This file can't be edited as text (binary, non-UTF-8, or symlink). Choose one side as a whole",
    submodule: "For a submodule conflict, choose one side's commit",
    deleteConflict: (side: string) =>
      `${side} deleted the file. Choose whether to keep or delete it`,
    pickOurs: (label: string) => `Use ${label}`,
    pickTheirs: (label: string) => `Use ${label}`,
    keepFile: 'Keep file',
    deleteFile: 'Delete file',
    unresolveRemake: 'Unresolve (redo auto-merge)',
    unresolveKeep: 'Unresolve (keep working tree)',
    resolved: 'Resolved (staged)',
    loading: 'Loading…',
  },
};
