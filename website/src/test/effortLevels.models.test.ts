/**
 * Model and effort are two choices: the picker's rows carry the backend's own
 * effort levels, and the effort gate reads them before any name heuristic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api/client', () => ({
  api: { models: vi.fn(), kirocrewConfig: vi.fn(() => Promise.resolve({})) },
}))

import { api } from '../api/client'
import { AcpAdapter } from '../providers/adapters/acp'
import { modelEffortCapable } from '../lib/effort'

beforeEach(() => { vi.clearAllMocks() })

describe('effort levels on model rows', () => {
  it('maps a non-empty effort_levels list and drops an empty one', async () => {
    ;(api.models as ReturnType<typeof vi.fn>).mockResolvedValue([
      { model_name: 'auto', description: '', effort_levels: [] },
      { model_name: 'gpt-6-astra', description: '', effort_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { model_name: 'gpt-5.5', description: '' },
    ])
    const rows = await new AcpAdapter().fetchAvailableModels('codex')
    expect(api.models).toHaveBeenCalledWith('codex')
    expect(rows.map(r => r.name)).toEqual(['auto', 'gpt-6-astra', 'gpt-5.5'])
    expect(rows[0].effortLevels).toBeUndefined()
    expect(rows[1].effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(rows[2].effortLevels).toBeUndefined()
  })

  it('a row with levels is authoritative; a row without falls back to the name heuristic', () => {
    const rows = [
      { name: 'auto', description: '' },
      { name: 'some-new-model', description: '', effortLevels: ['low', 'high'] },
      { name: 'gpt-6-astra', description: '', effortLevels: [] as string[] },
      { name: 'haiku-x', description: '' },
      { name: 'gpt-5.5', description: '' },
    ]
    expect(modelEffortCapable(rows, 'auto')).toBe(false)
    expect(modelEffortCapable(rows, 'some-new-model')).toBe(true)
    expect(modelEffortCapable(rows, 'gpt-6-astra')).toBe(false)
    expect(modelEffortCapable(rows, 'haiku-x')).toBe(false)
    expect(modelEffortCapable(rows, 'gpt-5.5')).toBe(true)
    expect(modelEffortCapable(rows, undefined)).toBe(false)
  })
})
