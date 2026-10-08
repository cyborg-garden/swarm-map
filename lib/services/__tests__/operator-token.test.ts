import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ensureOperatorToken, upsertEnvLine, OPERATOR_TOKEN_ENV } from '../operator-token'

let dir: string
let envPath: string
const prior = process.env[OPERATOR_TOKEN_ENV]

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-token-'))
  envPath = path.join(dir, '.env.local')
  delete process.env[OPERATOR_TOKEN_ENV]
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  if (prior === undefined) delete process.env[OPERATOR_TOKEN_ENV]
  else process.env[OPERATOR_TOKEN_ENV] = prior
})

describe('ensureOperatorToken', () => {
  it('generates a 64-hex token, persists it 0600, and sets process.env', () => {
    const res = ensureOperatorToken(envPath)
    expect(res.status).toBe('generated')
    const written = fs.readFileSync(envPath, 'utf8')
    const token = written.match(/HSM_OPERATOR_TOKEN=([0-9a-f]+)/)?.[1]
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(process.env[OPERATOR_TOKEN_ENV]).toBe(token)
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600)
  })

  it('is a no-op when the env already has a token', () => {
    process.env[OPERATOR_TOKEN_ENV] = 'operator-set'
    const res = ensureOperatorToken(envPath)
    expect(res).toEqual({ status: 'present', source: 'env' })
    expect(fs.existsSync(envPath)).toBe(false)
  })

  it('adopts an existing .env.local token instead of generating a new one', () => {
    fs.writeFileSync(envPath, 'OTHER=x\nHSM_OPERATOR_TOKEN=from-file\n')
    const res = ensureOperatorToken(envPath)
    expect(res).toEqual({ status: 'present', source: 'env' })
    expect(process.env[OPERATOR_TOKEN_ENV]).toBe('from-file')
    expect(fs.readFileSync(envPath, 'utf8')).toContain('HSM_OPERATOR_TOKEN=from-file')
  })

  it('replaces a blank token line rather than appending a duplicate', () => {
    fs.writeFileSync(envPath, 'HSM_OPERATOR_TOKEN=\nOTHER=x\n')
    ensureOperatorToken(envPath)
    const occurrences = (fs.readFileSync(envPath, 'utf8').match(/^HSM_OPERATOR_TOKEN=/gm) ?? []).length
    expect(occurrences).toBe(1)
    expect(fs.readFileSync(envPath, 'utf8')).toContain('OTHER=x')
  })

  it('upsertEnvLine preserves unrelated content and trailing newline shape', () => {
    expect(upsertEnvLine('A=1\n', 'B', '2')).toBe('A=1\nB=2\n')
    expect(upsertEnvLine('A=1', 'B', '2')).toBe('A=1\nB=2\n')
  })
})
