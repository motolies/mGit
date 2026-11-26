import { formatNumber, plural } from '../../format';
import type { Strings } from '../../strings';

/** 저장소 수 (`3 repositories`) */
const repos = (n: number) => `${formatNumber(n)} ${plural(n, 'repository', 'repositories')}`;

// 영어 사전: 가상 그룹 구역 (MR-13, ko.ts 의 `group` 과 키가 같다)
export const enGroup: Pick<Strings, 'group'> = {
  group: {
    kind: 'Group',
    section: 'Groups',
    empty:
      'No groups yet. Create one to work with repositories from different places in a single tab.',
    create: 'New Group…',
    fromFolder: 'Create Group from This Folder…',
    edit: 'Edit Group…',
    openNamed: (name: string) => `Open Group: ${name}`,
    editNamed: (name: string) => `Edit Group: ${name}`,
    remove: 'Delete Group',
    removeConfirm: (name: string) =>
      `Delete the group "${name}"? The repositories stay where they are.`,
    memberCount: repos,
    tabTitle: (name: string) => `Group: ${name}`,
    rootDetail: (n: number) => `Group · ${repos(n)}`,
    createTitle: 'New Group',
    editTitle: (name: string) => `Edit Group: ${name}`,
    name: 'Name',
    members: 'Repositories',
    alias: 'Alias',
    path: 'Location',
    addRepo: 'Add Repository…',
    addFromFolder: 'Add from Folder…',
    relocate: 'Locate…',
    exclude: 'Remove',
    save: 'Save',
    createButton: 'Create',
    cancel: 'Cancel',
    pickRepo: 'Choose a repository for the group',
    pickFolder: 'Choose a folder to search for repositories',
    pickRelocate: (alias: string) => `Choose the new location of ${alias}`,
    noMembers: 'Add at least one repository.',
    nameRequired: 'Enter a name.',
    skipped: (n: number) => `${formatNumber(n)} ${plural(n, 'item', 'items')} could not be added.`,
    issue: {
      missing: 'Path not found',
      notRepo: 'Not a repository',
      duplicate: 'Already in the group',
      nested: 'Inside another repository or contains one',
    },
    state: {
      missing: 'Not found',
      notRepo: 'Not a repository',
    },
    openNote: 'An open group changes in place. File tabs of removed repositories are closed.',
    missingTitle: 'Repositories not found',
    missingHint:
      'These are still in the group, but no repository is at that location now. Locate them again or remove them.',
    notRepoHint:
      "This isn't a repository, so it can't be expanded. Locate it again or remove it in Edit Group.",
    updateFailed: "Couldn't change the group",
    relocateNotRepo: 'The chosen folder is not the top of a repository.',
    topReadOnly:
      "Files can't be created at the top of a group. Create them inside a repository row.",
    aliasInvalid: (alias: string) =>
      `"${alias}" can't be an alias (empty, contains / or \\, is ., .., or .git, or over 255 bytes)`,
    aliasDuplicate: (alias: string) => `Duplicate alias (ignoring case): ${alias}`,
  },
};
