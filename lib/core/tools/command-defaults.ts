// The shipped command lists, as plain data with no imports, so the dashboard can show them too.
// The policy that reads them is command-policy.ts.

/**
 * The shipped allow list: commands that read and print, and change nothing.
 * Each is checked again for the few arguments that would make it write or run
 * something (ARG_CHECKS). Left out on purpose: tee, xxd and tree (they can
 * write a file), sed and awk (they can run commands), git (hooks and a pager),
 * printf, test and anything that runs a program.
 */
export const SHIPPED_ALLOW = [
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'wc', 'uname', 'date', 'echo', 'pwd', 'find', 'sort', 'uniq',
  'cut', 'tr', 'basename', 'dirname', 'realpath', 'readlink', 'stat', 'du', 'df', 'file', 'which', 'whoami', 'id',
  'true', 'false', 'seq', 'sleep', 'nl', 'tac', 'rev', 'fold', 'paste', 'diff', 'cmp', 'comm', 'md5sum', 'sha1sum',
  'sha256sum', 'od', 'printenv',
]

/** The shipped block list: wiping disks, stopping the machine, and the network (the cell has none, so these are only noise). */
export const SHIPPED_BLOCK = [
  'dd', 'mkfs', 'shred', 'wipefs', 'fdisk', 'sfdisk', 'parted', 'mkswap', 'shutdown', 'reboot', 'halt', 'poweroff', 'telinit',
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp', 'sftp', 'telnet', 'ftp', 'rsync',
]

