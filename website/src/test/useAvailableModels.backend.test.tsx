/**
 * useAvailableModels — per-backend query key.
 *
 * A slot with a per-session backend pick must read THAT harness's model list:
 * the key carries the pick so the cache entry is separate from the configured
 * backend's, the fetch passes it through to the adapter (which sends
 * `/api/models?backend=`), and the `['available-models']` prefix every
 * invalidation targets is kept. No pick keeps the pre-picker key byte for byte.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))

vi.mock('../providers', () => ({
  useProvider: () => ({ id: 'acp', fetchAvailableModels: fetchMock }),
}))

import { useAvailableModels } from '../hooks/useAvailableModels'

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('useAvailableModels backend key', () => {
  it('no pick: the shared key and an argument-less fetch', async () => {
    fetchMock.mockResolvedValue([{ name: 'auto', description: '' }, { name: 'm1', description: '' }])
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useAvailableModels(), { wrapper: wrapper(qc) })
    await waitFor(() => expect(result.current.map(m => m.name)).toContain('m1'))
    expect(fetchMock).toHaveBeenCalledWith(undefined)
    expect(qc.getQueryCache().findAll({ queryKey: ['available-models', 'acp'], exact: true })).toHaveLength(1)
  })

  it('a pick: its own key under the same prefix, and the fetch carries it', async () => {
    fetchMock.mockResolvedValue([{ name: 'auto', description: '' }, { name: 'gpt-x', description: '' }])
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useAvailableModels({ backend: 'codex' }), { wrapper: wrapper(qc) })
    await waitFor(() => expect(result.current.map(m => m.name)).toContain('gpt-x'))
    expect(fetchMock).toHaveBeenCalledWith('codex')
    expect(qc.getQueryCache().findAll({ queryKey: ['available-models', 'acp', 'codex'], exact: true })).toHaveLength(1)
    // The prefix invalidation used by the websocket refetch still reaches it.
    expect(qc.getQueryCache().findAll({ queryKey: ['available-models'] })).toHaveLength(1)
  })
})
