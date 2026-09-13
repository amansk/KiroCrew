/**
 * AcpBackendDropdown — the composer's per-session agent-backend picker.
 *
 * The rows come from `useAcpBackendChoices` (schema enum ∩ machine probe), the
 * same derivation the Developer > Agent Backend switch renders, so the pins here
 * are about the picker's OWN contract: which row is active, that the configured
 * backend's row sends `null` (follow the global) rather than a pin, that a
 * not-installed row is disabled, and that a pick closes the picker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

const { kirocrewConfigMock, schemaMock, acpBackendsMock } = vi.hoisted(() => ({
  kirocrewConfigMock: vi.fn(() => Promise.resolve({ agent: { acp_backend: 'claude' } })),
  schemaMock: vi.fn(),
  acpBackendsMock: vi.fn(),
}))

vi.mock('../api/client', () => ({
  api: { kirocrewConfig: kirocrewConfigMock, acpBackends: acpBackendsMock },
}))

vi.mock('../components/settingRef/useConfigSchema', () => ({
  useConfigSchema: () => schemaMock(),
}))

import { AcpBackendDropdown } from '../components/AcpBackendDropdown'

function probeRow(id: string, over: Partial<{ installed: string; missing_components: string[] }> = {}) {
  return { id, policy_id: id || 'kiro', selectable: true, installed: 'installed', missing_components: [], install_command: '', restart_required: false, ...over }
}

const RECT = { left: 100, top: 500, right: 160, bottom: 528, width: 60, height: 28, x: 100, y: 500, toJSON: () => ({}) } as DOMRect

function wrap(props: Partial<React.ComponentProps<typeof AcpBackendDropdown>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onSelect = vi.fn()
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <AcpBackendDropdown anchorRect={RECT} effective="claude" onSelect={onSelect} onClose={onClose} {...props} />
    </QueryClientProvider>,
  )
  return { onSelect, onClose }
}

beforeEach(() => {
  schemaMock.mockReturnValue(new Map([['agent.acp_backend', { path: 'agent.acp_backend', type: 'enum', enum: ['', 'claude', 'codex', 'opencode'] }]]))
  acpBackendsMock.mockResolvedValue({ backends: [
    probeRow(''),
    probeRow('claude'),
    probeRow('codex'),
    probeRow('opencode', { installed: 'missing', missing_components: ['opencode'] }),
  ] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('AcpBackendDropdown', () => {
  it('lists every selectable backend and marks the effective one active', async () => {
    wrap({ effective: 'codex' })
    await waitFor(() => expect(screen.getByTestId('acp-backend-option-codex')).toBeTruthy())
    expect(screen.getByTestId('acp-backend-option-kiro')).toBeTruthy()
    expect(screen.getByTestId('acp-backend-option-claude')).toBeTruthy()
    expect(screen.getByTestId('acp-backend-option-codex').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('acp-backend-option-claude').getAttribute('aria-selected')).toBe('false')
  })

  it('a per-session pick sends the id and closes', async () => {
    const { onSelect, onClose } = wrap({ effective: 'claude' })
    await waitFor(() => expect(screen.getByTestId('acp-backend-option-codex')).toBeTruthy())
    fireEvent.click(screen.getByTestId('acp-backend-option-codex'))
    expect(onSelect).toHaveBeenCalledWith('codex')
    expect(onClose).toHaveBeenCalled()
  })

  it("the configured backend's row sends null: follow the global, not a pin", async () => {
    const { onSelect } = wrap({ effective: 'codex' })
    // kirocrewConfig answers claude as the global; its row is the "default" one.
    await waitFor(() => expect(screen.getByTestId('acp-backend-option-claude').textContent).toMatch(/default/i))
    fireEvent.click(screen.getByTestId('acp-backend-option-claude'))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('a backend missing on this machine is disabled', async () => {
    const { onSelect } = wrap()
    await waitFor(() => expect((screen.getByTestId('acp-backend-option-opencode') as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(screen.getByTestId('acp-backend-option-opencode'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('Escape closes', async () => {
    const { onClose } = wrap()
    await waitFor(() => expect(screen.getByTestId('acp-backend-dropdown')).toBeTruthy())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
