import { useEffect, useRef } from 'react'
import { Check } from 'lucide-react'

import { useAcpBackendChoices } from '../hooks/useAcpBackendChoices'
import { i18nT } from '../i18n/t'

interface Props {
  anchorRect: DOMRect
  /** The harness this slot runs on: its pick, else the configured backend. */
  effective: string
  /** `null` sends "follow the global default"; a string is a per-session pick. */
  onSelect: (value: string | null) => void
  onClose: () => void
  disabled?: boolean
}

/**
 * The composer's per-session agent-backend picker.
 *
 * The rows come from `useAcpBackendChoices`, the ONE frontend derivation of
 * which harnesses a session can run on (schema enum ∩ this machine's probe), so
 * this list and the Developer > Agent Backend switch cannot disagree. Picking
 * the row that IS the configured backend clears the slot's pick rather than
 * pinning it: the slot then follows the global switch again, which is what a
 * user who "switches back" means.
 */
export function AcpBackendDropdown({ anchorRect, effective, onSelect, onClose, disabled }: Props) {
  const choices = useAcpBackendChoices()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - 308))
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={i18nT('pages.developer.agentBackendTab.agent_backend')}
      tabIndex={-1}
      data-testid="acp-backend-dropdown"
      className="fixed z-[9999] bg-bg-elevated border border-border rounded-xl shadow-xl min-w-[220px] max-w-[300px] flex flex-col p-1 gap-0.5 animate-slide-up"
      style={{ bottom: window.innerHeight - anchorRect.top + 4, left }}
    >
      <div role="listbox" aria-label={i18nT('pages.developer.agentBackendTab.agent_backend')} className="overflow-y-auto max-h-[280px]">
        {choices.visible.map(value => {
          const active = value === effective
          const isGlobal = value === choices.current
          const off = choices.disabledOption(value)
          return (
            <button
              key={value || 'kiro'}
              role="option"
              aria-selected={active}
              disabled={off || !!disabled}
              data-testid={`acp-backend-option-${value || 'kiro'}`}
              onClick={() => { onSelect(isGlobal ? null : value); onClose() }}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] text-left border-none bg-transparent cursor-pointer hover:bg-[color-mix(in_srgb,var(--bg-elevated)_84%,var(--text))] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${active ? 'text-text' : 'text-muted'}`}
              title={off
                ? i18nT('pages.developer.agentBackendTab.missing_components', {
                  components: (choices.probe(value)?.missing_components ?? []).join(', '),
                })
                : undefined}
            >
              <span className="shrink-0 text-muted">{choices.iconOf(value)}</span>
              <span className="truncate">{choices.nameOf(value)}</span>
              {isGlobal && (
                <span className="opacity-60 shrink-0 text-[12px]">· {i18nT('components.agentSelector.default')}</span>
              )}
              {active && <Check size={14} className="ml-auto shrink-0" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
