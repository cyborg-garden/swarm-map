import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { GitSource } from './artifacts-manifest'

export interface FetchOpts {
  // Base URL/path for resolving <org>/<repo>.git; the repo is appended as
  // `${baseUrl}/${org}/${repo}.git`. Defaults to GitHub HTTPS. A local path is
  // accepted (used by tests + self-hosted mirrors).
  baseUrl?: string
  // Build-time token (HSM server env, distinct from the agent's runtime token).
  // Supplied to git OUT OF BAND via GIT_ASKPASS — never placed in the URL or
  // argv, so it can't leak through `ps` or a clone error message. Ignored when
  // baseUrl is set.
  token?: string
  // Where clones are placed; a unique subdir is created per fetch.
  cacheRoot: string
}

function buildUrl(src: GitSource, opts: FetchOpts): string {
  if (opts.baseUrl) {
    return `${opts.baseUrl.replace(/\/+$/, '')}/${src.org}/${src.repo}.git`
  }
  // Username only (no secret). The password (token) is delivered via GIT_ASKPASS.
  // x-access-token is the correct username for GitHub token auth (works for ghp_,
  // ghu_, gho_, github_pat_ alike, unlike token-as-username).
  const userPrefix = opts.token ? 'x-access-token@' : ''
  return `https://${userPrefix}github.com/${src.org}/${src.repo}.git`
}

/**
 * Remove anything secret-shaped from a string before it is surfaced in an error.
 * Defense in depth: with GIT_ASKPASS the token should never reach here, but we
 * scrub the known token value + GitHub token shapes + any `user:secret@` URLs
 * regardless.
 */
export function redactSecrets(text: string, token?: string): string {
  let out = text
  if (token) out = out.split(token).join('***')
  return out
    .replace(/gh[posru]_[A-Za-z0-9]{16,}/g, '***')
    .replace(/github_pat_[A-Za-z0-9_]{16,}/g, '***')
    .replace(/(https?:\/\/[^/\s:@]+:)[^@\s]+@/g, '$1***@')
}

/**
 * Shallow-clone a git-sourced artifact at its PINNED tag and return the path to
 * the artifact root (the clone, or its subdir).
 *
 * Pinning + charset safety are enforced upstream by parseGitSource; here we
 * clone exactly that ref with --depth 1 and `--` so the ref/url can never be
 * read as a git option. The token is passed via GIT_ASKPASS (kept out of argv,
 * the URL, and any error). A subdir is resolved and verified to stay inside the
 * clone (defense against an escaping/`..` subdir that slipped through).
 */
export function fetchGitArtifact(src: GitSource, opts: FetchOpts): string {
  fs.mkdirSync(opts.cacheRoot, { recursive: true })
  const dest = fs.mkdtempSync(path.join(opts.cacheRoot, `${src.repo}-`))
  const url = buildUrl(src, opts)

  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  let askpass: string | undefined
  if (opts.token && !opts.baseUrl) {
    // A generic helper that echoes the token from the env — the SCRIPT holds no
    // secret; the token lives only in this child process's env, never on disk
    // in plaintext beyond the (env-reading) helper and never in argv.
    askpass = path.join(dest, '..', `.askpass-${path.basename(dest)}.sh`)
    fs.writeFileSync(askpass, '#!/bin/sh\nprintf %s "$GIT_ARTIFACT_TOKEN"\n', { mode: 0o700 })
    env.GIT_ASKPASS = askpass
    env.GIT_ARTIFACT_TOKEN = opts.token
  }

  try {
    // FIX 4b (audit): authoritative mutable-ref check BEFORE cloning. parseGitSource
    // only fast-fails a hardcoded set of branch NAMES; an attacker can name a branch
    // anything. `ls-remote --heads <url> <ref>` lists ONLY branch refs matching the
    // ref — non-empty output means the ref is a (mutable) branch, so we refuse. No
    // shell, argv array, `--` guard, same GIT_ASKPASS token mechanism as the clone.
    let heads: string
    try {
      heads = execFileSync('git', ['ls-remote', '--heads', '--', url, src.ref], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
        .toString()
        .trim()
    } catch (e) {
      const err = e as { stderr?: Buffer; message?: string }
      const raw = (err.stderr?.toString() || err.message || 'ls-remote failed').trim()
      throw new Error(
        `git ls-remote failed for ${src.org}/${src.repo}#${src.ref}: ${redactSecrets(raw, opts.token)}`,
      )
    }
    if (heads.length > 0) {
      // Refused before any clone touches disk. Redacted (no secret-shaped data).
      throw new Error(
        `git ref '${src.ref}' resolves to a mutable branch; pin to a tag or commit SHA`,
      )
    }

    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', src.ref, '--', url, dest], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env,
      })
    } catch (e) {
      const err = e as { stderr?: Buffer; message?: string }
      const raw = (err.stderr?.toString() || err.message || 'clone failed').trim()
      throw new Error(
        `git clone failed for ${src.org}/${src.repo}#${src.ref}: ${redactSecrets(raw, opts.token)}`,
      )
    }

    // A tag can be moved or re-created on the remote. When the manifest records
    // the commit the tag pointed at on review, the clone must be that commit.
    if (src.commit) {
      let head = ''
      try {
        head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dest, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      } catch {
        /* head stays empty and is refused below */
      }
      if (head.toLowerCase() !== src.commit.toLowerCase()) {
        fs.rmSync(dest, { recursive: true, force: true })
        throw new Error(
          `git ref '${src.ref}' of ${src.org}/${src.repo} is at ${head || 'an unreadable commit'}, not the recorded ${src.commit}. Not installed.`,
        )
      }
    }
  } finally {
    if (askpass) {
      try {
        fs.rmSync(askpass, { force: true })
      } catch {
        /* best effort */
      }
    }
  }

  if (!src.subdir) return dest

  const root = path.resolve(dest)
  const resolved = path.resolve(dest, src.subdir)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`git artifact subdir escapes the clone: ${src.subdir}`)
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`git artifact subdir not found in ${src.org}/${src.repo}#${src.ref}: ${src.subdir}`)
  }
  return resolved
}
