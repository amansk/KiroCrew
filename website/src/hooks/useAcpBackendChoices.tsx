import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bot, Boxes, Sparkles, Terminal } from 'lucide-react'

import { api } from '../api/client'
import type { AcpBackendProbe } from '../api/client'
import { useConfigSchema } from '../components/settingRef/useConfigSchema'
import { i18nT } from '../i18n/t'

/** The config field the global switch owns. Also the schema path the options are gated on. */
export const ACP_BACKEND_CONFIG_KEY = 'agent.acp_backend'

/**
 * Backend ids, verbatim from `acp/types.py`. `''` (Kiro CLI) is the shipped
 * default and is a REAL value, not "unset" — the empty string is how the core
 * spells the Kiro backend, so it must round-trip as itself.
 */
export const KIRO = ''
export const CLAUDE = 'claude'
export const KAS = 'kas'

/**
 * The agents this frontend has a translated name and an icon for.
 *
 * A FLOOR for what a chooser renders, never a ceiling — see `candidates`. Every id
 * here is a core agent the server always knows, so listing them costs nothing and
 * keeps a control populated while the schema and probe queries are still in
 * flight. An agent absent from this list still gets a row once a server answer
 * names it, labelled with its `policy_id`.
 */
const NAMED = [KIRO, CLAUDE, KAS]

/**
 * Poll interval for the machine probe, in ms.
 *
 * Matched to `acp_backend_probe.CACHE_TTL_SECONDS` (30s) on purpose: the endpoint
 * serves that cache, so polling faster only adds requests that return the same
 * bytes, and polling slower leaves a just-installed harness disabled for longer than
 * the server would.
 */
const PROBE_REFRESH_MS = 30_000

export interface AcpBackendChoices {
  /** The globally configured backend (`agent.acp_backend`); KIRO when the key is absent. */
  current: string
  currentLoading: boolean
  currentError: boolean
  refetchCurrent: () => void
  /** The live selectable set from the schema, or `undefined` while in flight. */
  selectable: string[] | undefined
  probe: (value: string) => AcpBackendProbe | undefined
  /** Every id a chooser could render, sorted; see the hook body. */
  candidates: string[]
  /** `candidates` minus the ids this deployment may not select (`current` always kept). */
  visible: string[]
  /** `visible` minus the ids a chip would be dead for: not installed, or gateway restart needed. */
  offered: string[]
  notInstalled: (value: string) => boolean
  needsRestart: (value: string) => boolean
  disabledOption: (value: string) => boolean
  nameOf: (value: string) => string
  iconOf: (value: string) => ReactNode
}

/**
 * The ONE frontend derivation of "which agent backends can a session run on".
 *
 * Shared by the Developer > Agent Backend switch (which writes the global
 * `agent.acp_backend`) and the New Chat menu's per-session rows (which send the
 * pick on `POST /api/chat/slots`). Both read the same two server answers so the
 * two controls cannot disagree about what is on offer:
 *
 * - the SCHEMA gate, `GET /api/config/schema` `enumValues`, which the backend
 *   resolves per request from `acp_backends.selectable_backend_values()` — the
 *   same owner the PATCH allowlist and the slot create validate against; and
 * - the PROBE gate, `GET /api/acp-backends`, this machine's install verdict.
 *
 * Nothing here is a literal list of backends. `NAMED` is a floor for the
 * loading state only; an agent an edition registers shows up with no edit here.
 */
export function useAcpBackendChoices({ pollProbe = true }: { pollProbe?: boolean } = {}): AcpBackendChoices {
  const schema = useConfigSchema()

  const cfgQ = useQuery<{ agent?: { acp_backend?: string } }>({
    queryKey: ['kirocrewConfig'],
    queryFn: () => api.kirocrewConfig(),
  })

  /**
   * The machine probe. `retry: false` because the two expected failures — 403 for a
   * non-owner and 404 on a gateway that predates the endpoint — are permanent
   * answers, and retrying them just delays the fail-open path every consumer
   * already handles. A rejection is never surfaced as an error to the user: the
   * absence of probe information is not something they can act on.
   *
   * `staleTime: 0` + `refetchInterval` are load-bearing, not tuning. This app sets a
   * GLOBAL `staleTime: Infinity`, and inheriting it makes the probe answer permanent
   * for the life of the page: an operator who follows the panel's own install
   * instruction would leave the option disabled with no way to re-ask short of a
   * reload. The interval matches the server probe's own TTL, so a poll can never be
   * cheaper than the answer it re-reads, and the endpoint is a resolver read behind
   * that TTL cache rather than a fresh shell-out per request.
   */
  const probeQ = useQuery<{ backends: AcpBackendProbe[] }>({
    queryKey: ['acpBackends'],
    queryFn: () => api.acpBackends(),
    retry: false,
    staleTime: 0,
    // A chooser polls so a just-installed harness lights up; a header chip that
    // only NAMES a slot's backend has no such need and must not add a poll per
    // open chat pane.
    refetchInterval: pollProbe ? PROBE_REFRESH_MS : false,
  })

  /**
   * `?? KIRO` is right for a config that genuinely omits the key — the shipped
   * default really is Kiro CLI. A FAILED read is not the default value; the
   * `currentError` flag lets a control offer a retry instead of guessing.
   */
  const current = cfgQ.data?.agent?.acp_backend ?? KIRO

  /**
   * `undefined` while the schema is in flight — every option stays enabled rather
   * than flashing disabled and then live, which would read as a broken control on
   * a slow load. The server-side allowlist is the real gate either way, so an
   * optimistic enable can only cost one visible refusal.
   */
  const selectable = typeof schema?.get === 'function' ? schema.get(ACP_BACKEND_CONFIG_KEY)?.enum : undefined

  /**
   * This machine's verdict for one backend, or `undefined` when there is none —
   * query in flight, 403, 404, an outright failure, or a row the payload omits.
   * Every consumer treats `undefined` as "say nothing, gate nothing".
   */
  // Shape-checked rather than trusted: this hook now renders on every chat
  // surface, where a generic fetch stub in a test (or an older gateway) can
  // answer the probe with a body that has no `backends` array at all. That is
  // "no probe information", which every consumer already fails open on.
  const probeRows: AcpBackendProbe[] = Array.isArray(probeQ.data?.backends) ? probeQ.data.backends : []
  const probe = (value: string): AcpBackendProbe | undefined =>
    probeRows.find(b => b.id === value)

  /**
   * Not selectable = this build or the live policy will not serve it. Read from the
   * schema first, since that is the set the server validates against; the probe's
   * own `selectable` is the same fact from the same source, so it is honoured too
   * and the two cannot disagree in a way that lets a dead option look live. Both
   * fall open when absent, so an in-flight query or a 403 hides nothing.
   */
  const unavailable = (value: string) =>
    (Array.isArray(selectable) ? !selectable.includes(value) : false) || probe(value)?.selectable === false

  /**
   * Every agent id a chooser could render, from the SERVER rather than a literal.
   *
   * Union of the schema enum and the probe payload, because the two answer
   * different questions and either can be in flight: the enum is what the server
   * accepts, the probe is every id the core knows (including ones this build
   * cannot select, which `unavailable` then drops). `NAMED` is unioned in as a
   * FLOOR, not a ceiling: it only guarantees the core agents still have rows when
   * neither query has answered. `current` joins so the saved value always has a
   * chip.
   *
   * Sorted rather than left in arrival order: the two kiro-family harnesses first —
   * KIRO because it is the default and the floor, then KAS — and everything else by
   * `policy_id`, which is the order the probe endpoint already sorts by. Set
   * iteration order would otherwise follow whichever query resolved first and
   * reshuffle the control between renders.
   */
  const candidates = Array.from(
    new Set<string>([
      ...NAMED,
      current,
      ...(Array.isArray(selectable) ? selectable : []),
      ...probeRows.map(b => b.id),
    ]),
  ).sort((a, b) => {
    if (a === KIRO) return -1
    if (b === KIRO) return 1
    // KAS second, ahead of the byte order below. It is not an adapter: it is kiro-cli's
    // own ACP relay, resolved from the same binary and sharing kiro's install verdict
    // (`_probe_kas` delegates to `_probe_kiro`), so the two harnesses that are really
    // one install belong adjacent at the head of the row. Under `policy_id` alone it
    // sorts on 'k' and lands behind every adapter whose name happens to start earlier
    // ('claude', 'codex'), which reads to the operator as a rank rather than an
    // alphabet.
    if (a === KAS) return -1
    if (b === KAS) return 1
    // Byte order, not `localeCompare`/`compareText`: these are machine identifiers,
    // and the point of the sort (see above) is to reproduce the order the probe
    // endpoint already returned them in. A collator reads the READER's locale, so
    // the same deployment would order the chips differently per browser -- the
    // between-render reshuffle this sort exists to prevent, just keyed on locale
    // instead of query timing.
    const ka = probe(a)?.policy_id || a
    const kb = probe(b)?.policy_id || b
    if (ka === kb) return 0
    return ka < kb ? -1 : 1
  })

  /**
   * An agent the deployment may not select is HIDDEN, not shown disabled. A greyed
   * chip invites the reader to find out how to enable it, and under a managed policy
   * there is nothing they can do — the answer is not on their machine. `current` is
   * always kept: a control rendering no selected chip is a worse failure than one
   * extra row.
   */
  const visible = candidates.filter(value => value === current || !unavailable(value))

  /**
   * Installed === 'missing' is the only verdict that disables. `'unknown'` and an
   * absent row explicitly do not: an optimistic disable costs a user a control they
   * were entitled to and an install they did not need.
   */
  const notInstalled = (value: string) => probe(value)?.installed === 'missing'
  /**
   * Installed on disk, but this gateway process cached its absence and cannot
   * spawn it until restarted. Disabling is right here even though the binary IS
   * present: the click would reach a spawn that fails.
   */
  const needsRestart = (value: string) => probe(value)?.restart_required === true
  const disabledOption = (value: string) => notInstalled(value) || needsRestart(value)

  const offered = visible.filter(value => !disabledOption(value))

  /**
   * Translated display names for the agents this frontend knows by name.
   *
   * Deliberately NOT the list of agents a chooser renders — see `candidates`. An id
   * absent here still gets a row; `nameOf` falls back to the server's `policy_id`,
   * which exists precisely to be a human-readable wire name. KIRO is the empty
   * string, so the `||` chain must not treat it as absent — it is always in NAME,
   * which is why the lookup comes first.
   */
  const NAME: Record<string, string> = {
    [KIRO]: i18nT('pages.developer.agentBackendTab.kiro_cli'),
    [CLAUDE]: i18nT('pages.developer.agentBackendTab.claude_code'),
    [KAS]: i18nT('pages.developer.agentBackendTab.kas_kiro_agent'),
  }
  const ICON: Record<string, ReactNode> = {
    [KIRO]: <Terminal size={14} />,
    [CLAUDE]: <Sparkles size={14} />,
    [KAS]: <Bot size={14} />,
  }
  const nameOf = (value: string): string => NAME[value] || probe(value)?.policy_id || value
  /** Generic mark for an agent this frontend has no icon for. */
  const iconOf = (value: string): ReactNode => ICON[value] ?? <Boxes size={14} />

  return {
    current,
    currentLoading: cfgQ.isLoading,
    currentError: cfgQ.isError,
    refetchCurrent: () => { void cfgQ.refetch() },
    selectable,
    probe,
    candidates,
    visible,
    offered,
    notInstalled,
    needsRestart,
    disabledOption,
    nameOf,
    iconOf,
  }
}

/**
 * How a chat view reads a slot's agent backend.
 *
 * `effective` is the harness the slot runs on: its own pick, else the configured
 * backend; `label` names it for the composer chip, which every slot shows.
 * `isPick` is true when the slot carries its own pick. `backendParam` is what
 * the slot's model list is fetched for: the pick verbatim, or `undefined` for a
 * slot that follows the global (the server then answers for the configured
 * backend itself, so an in-flight config read never fetches the wrong list).
 */
export function useSlotAcpBackend(acpBackend: string | null | undefined): {
  label: string
  effective: string
  isPick: boolean
  backendParam: string | undefined
} {
  const { current, nameOf } = useAcpBackendChoices({ pollProbe: false })
  const isPick = acpBackend != null
  const effective = isPick ? acpBackend : current
  return { label: nameOf(effective), effective, isPick, backendParam: isPick ? acpBackend : undefined }
}
