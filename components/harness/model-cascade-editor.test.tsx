/**
 * Tests for ModelCascadeEditor (issue #149).
 *
 * The bug: the editor seeded its local cascade ONCE from whatever props it was
 * first mounted with. On the harness page that first mount happens before
 * GET /models resolves (provider '', fallbackProviders []), so every row was
 * stamped `anthropic` with no base_url, and the real ollama rows never replaced
 * that seed. Reorder + save then wrote `anthropic` onto every row.
 *
 * Asserted on the RENDERED rows and the SAVED body, not on a helper — the
 * failure was a state-lifecycle bug, not a pure-function bug.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModelCascadeEditor, type FallbackProviderEntry } from './model-cascade-editor'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const OLLAMA_URL = 'http://host.docker.internal:11434/v1'

// Provider names also appear as <option>s in the add-model <select>; only the
// per-row badge counts as "a row carries this provider".
function rowProviders(name: string): HTMLElement[] {
  return screen.queryAllByText(name).filter((el) => el.tagName !== 'OPTION')
}

const LOADED: FallbackProviderEntry[] = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL },
]

function preLoadProps(onSave = vi.fn()) {
  // What the page renders before GET /models has resolved: harness.models are
  // known (string list) but provider/fallbackProviders are not.
  return {
    models: ['claude-sonnet-4-6', 'qwen3:30b'],
    provider: '',
    fallbackProviders: [] as FallbackProviderEntry[],
    onSave,
    saving: false,
    harnessId: 'h_test',
  }
}

function loadedProps(onSave = vi.fn()) {
  return {
    models: ['claude-sonnet-4-6', 'qwen3:30b'],
    provider: 'anthropic',
    fallbackProviders: LOADED,
    onSave,
    saving: false,
    harnessId: 'h_test',
  }
}

describe('ModelCascadeEditor — seeding', () => {
  it('does not invent an anthropic provider for rows when provider is unknown and no fallback_providers', () => {
    render(<ModelCascadeEditor {...preLoadProps()} />)
    // No row may carry a guessed provider. The editor must wait for real data.
    expect(rowProviders('anthropic')).toHaveLength(0)
    expect(screen.queryByText('qwen3:30b')).toBeNull()
    expect(screen.getByText(/no models configured/i)).toBeInTheDocument()
  })

  it('seeds from string models when provider is known but fallback_providers is absent', () => {
    render(
      <ModelCascadeEditor
        {...preLoadProps()}
        provider="openrouter"
        models={['anthropic/claude-opus-4.7']}
      />
    )
    expect(screen.getByText('anthropic/claude-opus-4.7')).toBeInTheDocument()
    expect(rowProviders('openrouter')).toHaveLength(1)
  })

  it('re-seeds from loaded props after a pre-load mount, keeping ollama + base_url', () => {
    const { rerender } = render(<ModelCascadeEditor {...preLoadProps()} />)
    rerender(<ModelCascadeEditor {...loadedProps()} />)

    expect(screen.getByText('qwen3:30b')).toBeInTheDocument()
    expect(rowProviders('ollama')).toHaveLength(1)
    expect(screen.getByText(OLLAMA_URL)).toBeInTheDocument()
    expect(rowProviders('anthropic')).toHaveLength(1)
  })

  it('save after pre-load → loaded → reorder sends ollama + base_url on the promoted row', () => {
    const onSave = vi.fn()
    const { rerender } = render(<ModelCascadeEditor {...preLoadProps(onSave)} />)
    rerender(<ModelCascadeEditor {...loadedProps(onSave)} />)

    // Promote the local model to primary.
    const moveUps = screen.getAllByTitle('Move up')
    fireEvent.click(moveUps[1])
    fireEvent.click(screen.getByRole('button', { name: /save cascade/i }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith([
      { provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL },
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ])
  })
})

describe('ModelCascadeEditor — never clobber user edits', () => {
  it('keeps a user edit when the server cascade changes after the user has touched the editor', () => {
    const onSave = vi.fn()
    const { rerender } = render(<ModelCascadeEditor {...loadedProps(onSave)} />)

    // User removes the anthropic row.
    fireEvent.click(screen.getAllByTitle('Remove')[0])
    expect(screen.queryByText('claude-sonnet-4-6')).toBeNull()

    // A background refetch delivers a DIFFERENT server cascade. Same-value
    // props would not exercise the guard at all (the sync key is unchanged).
    rerender(
      <ModelCascadeEditor
        {...loadedProps(onSave)}
        fallbackProviders={[{ provider: 'ollama', model: 'glm4:9b', base_url: OLLAMA_URL }]}
      />
    )

    // The user's list must survive: no server row, no removed row.
    expect(screen.queryByText('glm4:9b')).toBeNull()
    expect(screen.queryByText('claude-sonnet-4-6')).toBeNull()
    expect(screen.getByText('qwen3:30b')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /save cascade/i }))
    expect(onSave).toHaveBeenCalledWith([
      { provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL },
    ])
  })

  it('clears dirty once the server reflects the saved list (Save button disappears)', () => {
    const onSave = vi.fn()
    const { rerender } = render(<ModelCascadeEditor {...loadedProps(onSave)} />)
    fireEvent.click(screen.getAllByTitle('Remove')[0])
    fireEvent.click(screen.getByRole('button', { name: /save cascade/i }))
    expect(onSave).toHaveBeenCalledTimes(1)

    // Refetch after the save returns exactly what the user saved.
    rerender(
      <ModelCascadeEditor
        {...loadedProps(onSave)}
        models={['qwen3:30b']}
        fallbackProviders={[{ provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL }]}
      />
    )
    expect(screen.getByText('qwen3:30b')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save cascade/i })).toBeNull()
  })

  it('an untouched editor follows a server-side change to the cascade', () => {
    const { rerender } = render(<ModelCascadeEditor {...loadedProps()} />)
    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument()

    rerender(
      <ModelCascadeEditor
        {...loadedProps()}
        fallbackProviders={[{ provider: 'ollama', model: 'glm4:9b', base_url: OLLAMA_URL }]}
      />
    )
    expect(screen.getByText('glm4:9b')).toBeInTheDocument()
    expect(screen.queryByText('claude-sonnet-4-6')).toBeNull()
    // Nothing to save — the editor mirrors the server.
    expect(screen.queryByRole('button', { name: /save cascade/i })).toBeNull()
  })
})
