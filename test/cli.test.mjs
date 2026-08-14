// Exercises the CLI against a **real** git repository with `ghq`, `gwq` and
// `fzf` shims on PATH. git is not shimmed: worktree creation, branch existence
// and fast-forwarding are the logic under test, and faking them would only test
// the fakes. No network, no TTY.
//
// The interactive fzf branch picker is covered by the manual matrix in
// CLAUDE.md — everything reachable without a terminal lives here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gwqget.mjs');
const SLUG = 'github.com/alice/api';

let sandbox, ghqRoot, wtBase, originDir, shimDir;

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout ?? '').trim();
};

before(() => {
  // realpath the sandbox: on macOS $TMPDIR is /var/... which is a symlink to
  // /private/var/..., and `git worktree list --porcelain` reports the resolved
  // form. Expectations built from an unresolved root would never match.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'gwqget-')));
  ghqRoot = join(sandbox, 'ghq');
  wtBase = join(sandbox, 'worktrees');
  originDir = join(sandbox, 'origin.git');
  mkdirSync(ghqRoot, { recursive: true });
  mkdirSync(wtBase, { recursive: true });

  // An origin with two branches: main, and feat/login — whose slash is the
  // reason a worktree directory name can never be trusted as a branch name.
  const seed = join(sandbox, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'Test');
  writeFileSync(join(seed, 'README.md'), '# api\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'init');
  git(seed, 'branch', 'feat/login');
  git(sandbox, 'clone', '-q', '--bare', seed, originDir);

  shimDir = mkdtempSync(join(tmpdir(), 'gwqget-shims-'));
  const write = (name, body) => {
    const p = join(shimDir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };

  // `ghq get <url>` clones from the local origin instead of the network, and
  // lands it where `ghq root`/<slug> says it will.
  write('ghq', `#!/bin/sh
case "$1" in
  --version) echo "ghq version 1.6.1"; exit 0 ;;
  root)      echo "${ghqRoot}"; exit 0 ;;
  list)
    # \`list -e <owner/repo>\` — host inference. Only answer for what exists.
    for a in "$@"; do :; done
    if [ -d "${ghqRoot}/${SLUG}" ] && [ "\${GWQGET_TEST_KNOWN:-1}" = "1" ]; then
      echo "${SLUG}"
    fi
    exit 0 ;;
  get)
    dest="${ghqRoot}/${SLUG}"
    mkdir -p "$(dirname "$dest")"
    git clone -q "${originDir}" "$dest" || exit 1
    exit 0 ;;
esac
exit 0
`);

  // gwq's real naming template is its own business; the shim only has to put
  // the worktree somewhere and report the git command it ran, which is how the
  // CLI recovers a collision path from the error text.
  write('gwq', `#!/bin/sh
[ "$1" = "--version" ] && { echo "gwq version v0.1.1"; exit 0; }
[ "$1" = "add" ] || exit 0
shift
if [ "$1" = "-b" ]; then newbranch=1; branch="$2"; else newbranch=0; branch="$1"; fi
slug=$(printf '%s' "$branch" | tr '/' '-')
wt="${wtBase}/$slug"
if [ -e "$wt" ]; then
  echo "Error: failed to create worktree" >&2
  if [ "$newbranch" = "1" ]; then
    echo "  git worktree add -b $branch $wt: destination exists" >&2
  else
    echo "  git worktree add $wt $branch: destination exists" >&2
  fi
  exit 1
fi
if [ "$newbranch" = "1" ]; then
  git worktree add -b "$branch" "$wt" >/dev/null 2>&1 || exit 1
else
  git worktree add "$wt" "$branch" >/dev/null 2>&1 || exit 1
fi
echo "Created worktree at $wt"
exit 0
`);

  write('fzf', `#!/bin/sh
[ "$1" = "--version" ] && { echo "0.74.1"; exit 0; }
# No TTY in tests, so the interactive picker must never be reached.
echo "fzf: interactive UI invoked in a test" >&2
exit 2
`);
});

after(() => {
  for (const d of [sandbox, shimDir]) {
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function run(args, { env = {} } = {}) {
  const childEnv = {
    ...process.env, PATH: `${shimDir}:${process.env.PATH}`, NO_COLOR: '1', ...env,
  };
  // We force NO_COLOR; node itself warns to stderr when FORCE_COLOR is also
  // set, so a developer who exports it would otherwise see phantom failures.
  delete childEnv.FORCE_COLOR;
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: childEnv });
}

// stderr is shared, not ours alone: node emits its own warnings there. Strip
// them before asserting the program itself stayed silent.
const ourStderr = (s) =>
  s.split('\n')
    .filter((l) => l && !/^\(node:\d+\)/.test(l) && !/^\(Use `node --trace-warnings/.test(l))
    .join('\n');

const out = (r) => {
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  return JSON.parse(r.stdout);
};
const jsonLine = (s) => JSON.parse(s.split('\n').find((l) => l.startsWith('{')));

const resetClone = () => {
  rmSync(join(ghqRoot, SLUG), { recursive: true, force: true });
  rmSync(wtBase, { recursive: true, force: true });
  mkdirSync(wtBase, { recursive: true });
};

// ── --init ───────────────────────────────────────────────────────────────────

for (const shell of ['zsh', 'bash', 'fish']) {
  test(`--init ${shell} emits a function and the three-step resolver`, () => {
    const r = run(['--init', shell]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gwqget/);
    assert.match(r.stdout, /--quiet/);
    assert.match(r.stdout, /npx -y/);
    assert.ok(r.stdout.includes(BIN));
    assert.equal(ourStderr(r.stderr), '');
  });
}

for (const checker of ['zsh', 'bash']) {
  test(`--init ${checker} output parses under ${checker} -n`, (t) => {
    if (spawnSync(checker, ['-c', 'true'], { stdio: 'ignore' }).error) {
      return t.skip(`${checker} not installed`);
    }
    const r = spawnSync(checker, ['-n'], { input: run(['--init', checker]).stdout, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}

test('--init fish output parses under fish -n', (t) => {
  if (spawnSync('fish', ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip('fish not installed');
  const r = spawnSync('fish', ['-n', '/dev/stdin'], { input: run(['--init', 'fish']).stdout, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('--cmd renames the emitted function', () => {
  assert.match(run(['--init', 'zsh', '--cmd', 'gw']).stdout, /^gw\(\) \{/m);
});

// ── validation ───────────────────────────────────────────────────────────────

test('no repository argument is a validation error', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a repository is required/);
});

test('a third positional is rejected', () => {
  const r = run(['a/b', 'main', 'extra']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unexpected extra arguments: extra/);
});

test('--json and --quiet are mutually exclusive', () => {
  const r = run(['--json', '--quiet', 'a/b']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_VALIDATION');
});

test('an unparseable spec exits with E_SPEC', () => {
  const r = run(['--json', 'justaword']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_SPEC');
});

// ── spec parsing ─────────────────────────────────────────────────────────────

const specCases = [
  ['owner/repo, host inferred from an existing clone', 'alice/api', SLUG],
  ['host/owner/repo', 'github.com/alice/api', SLUG],
  ['full https URL', 'https://github.com/alice/api', SLUG],
  ['URL with a .git suffix', 'https://github.com/alice/api.git', SLUG],
  ['URL with a trailing slash', 'https://github.com/alice/api/', SLUG],
  ['scp form', 'git@github.com:alice/api.git', SLUG],
  ['ssh:// URL with userinfo', 'ssh://git@github.com/alice/api', SLUG],
  ['query string stripped', 'https://github.com/alice/api?tab=readme', SLUG],
  ['fragment stripped', 'https://github.com/alice/api#readme', SLUG],
];

for (const [name, spec, expected] of specCases) {
  test(`spec: ${name}`, () => {
    const j = out(run(['--json', '-n', '--no-fetch', spec, 'main']));
    assert.equal(j.repo.slug, expected);
  });
}

test('spec: /tree/<branch> supplies the branch', () => {
  const j = out(run(['--json', '-n', '--no-fetch', 'https://github.com/alice/api/tree/feat/login']));
  assert.equal(j.branch, 'feat/login', 'a slashed branch must survive the URL tail');
});

test('spec: an explicit branch argument beats the /tree/ hint', () => {
  const j = out(run(['--json', '-n', '--no-fetch', 'https://github.com/alice/api/tree/feat/login', 'main']));
  assert.equal(j.branch, 'main');
});

test('spec: an unknown owner/repo falls back to github.com', () => {
  const r = run(['--json', '-n', '--no-fetch', 'nobody/nothing', 'main'], {
    env: { GWQGET_TEST_KNOWN: '0' },
  });
  // The clone will fail (the shim only serves one slug), but the host decision
  // is already visible in the error path's spec — assert via a successful slug
  // instead: `alice/api` with inference disabled still resolves to github.com.
  assert.equal(r.status, 1);
  const j2 = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main'], {
    env: { GWQGET_TEST_KNOWN: '0' },
  }));
  assert.equal(j2.repo.host, 'github.com');
});

// ── the main flow ────────────────────────────────────────────────────────────

test('a missing clone is cloned, then a worktree is created', () => {
  resetClone();
  assert.ok(!existsSync(join(ghqRoot, SLUG)));
  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  assert.equal(j.created, true);
  assert.equal(j.branch, 'feat/login');
  assert.equal(j.isMainClone, false);
  assert.ok(existsSync(join(j.path, 'README.md')), 'the worktree must be checked out');
  assert.equal(git(j.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/login');
});

test('re-running is idempotent — same path, created:false', () => {
  const first = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  const second = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  assert.equal(second.path, first.path);
  assert.equal(second.created, false);
});

test('the main clone holding the branch is reported as isMainClone', () => {
  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  assert.equal(j.isMainClone, true, 'git worktree list includes the main working tree');
  assert.equal(j.path, j.clone);
  assert.equal(j.created, false);
});

test('a branch that exists nowhere is created with -b', () => {
  resetClone();
  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'brand/new']));
  assert.equal(j.created, true);
  assert.equal(j.branch, 'brand/new');
  assert.equal(git(j.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'brand/new');
});

test('an origin-only branch is checked out without -b', () => {
  resetClone();
  // feat/login exists on origin but not locally in a fresh clone.
  const clone = join(ghqRoot, SLUG);
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  assert.equal(
    spawnSync('git', ['-C', clone, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/login']).status,
    1, 'precondition: feat/login is not a local branch yet',
  );
  const j = out(run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']));
  assert.equal(j.created, true);
  // Checked out from origin, so it tracks — not an orphan created by -b.
  assert.equal(git(j.path, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'origin/feat/login'));
});

// ── collisions ───────────────────────────────────────────────────────────────

test('a colliding directory fails with actionable advice', () => {
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const collide = join(wtBase, 'feat-login');
  mkdirSync(collide, { recursive: true });
  writeFileSync(join(collide, 'stray.txt'), 'in the way\n');

  const r = run(['--json', '-n', '--no-fetch', 'alice/api', 'feat/login']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_WORKTREE');
  assert.ok(existsSync(join(collide, 'stray.txt')), 'the collision must be left untouched without -f');
});

test('-f moves the colliding directory aside and succeeds', () => {
  const collide = join(wtBase, 'feat-login');
  assert.ok(existsSync(collide), 'precondition: the previous test left the collision in place');

  const j = out(run(['--json', '-n', '--no-fetch', '-f', 'alice/api', 'feat/login']));
  assert.equal(j.created, true);
  assert.equal(j.path, collide);
  assert.ok(existsSync(join(collide, 'README.md')), 'the worktree replaced the stray directory');

  const backups = readdirSync(wtBase).filter((n) => n.startsWith('feat-login.bak-'));
  assert.equal(backups.length, 1, 'exactly one timestamped backup');
  assert.ok(
    existsSync(join(wtBase, backups[0], 'stray.txt')),
    'the stray file must survive inside the backup — -f moves, never deletes',
  );
});

// ── output contract ──────────────────────────────────────────────────────────

test('--quiet prints the path and nothing else on stdout', () => {
  const r = run(['--quiet', '--no-fetch', 'alice/api', 'main']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), join(ghqRoot, SLUG));
  assert.match(r.stderr, /gwqget/, 'progress still narrates on stderr in --quiet');
});

test('--no-cd prints nothing on stdout so the shell function stays put', () => {
  const r = run(['--quiet', '--no-fetch', '-n', 'alice/api', 'main']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'a path here would make the wrapper cd anyway');
});

test('progress never contaminates stdout', () => {
  const r = run(['--quiet', '--no-fetch', 'alice/api', 'feat/login']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1,
    'stdout must be exactly one line: the path');
  assert.ok(r.stdout.startsWith('/'));
});

// ── dependencies ─────────────────────────────────────────────────────────────

test('a missing gwq exits 127 with the brew command', () => {
  const bare = mkdtempSync(join(tmpdir(), 'gwqget-noshim-'));
  for (const n of ['git', 'ghq']) {
    writeFileSync(join(bare, n), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bare, n), 0o755);
  }
  const r = spawnSync(process.execPath, [BIN, '--json', 'a/b'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bare, NO_COLOR: '1' },
  });
  rmSync(bare, { recursive: true, force: true });
  assert.equal(r.status, 127);
  assert.equal(jsonLine(r.stderr).error.code, 'E_DEPS');
  assert.match(jsonLine(r.stderr).error.message, /brew install d-kuro\/tap\/gwq/);
});

test('no branch and no TTY names the candidates instead of hanging', () => {
  resetClone();
  out(run(['--json', '-n', '--no-fetch', 'alice/api', 'main']));
  const r = run(['--json', '-n', '--no-fetch', 'alice/api']);
  assert.equal(r.status, 1);
  const err = jsonLine(r.stderr);
  assert.equal(err.error.code, 'E_BRANCH');
  assert.match(err.error.message, /main/, 'the message must list real branches');
});
