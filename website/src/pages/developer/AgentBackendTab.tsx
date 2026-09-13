import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../api/client'
import ErrorBoundary from '../../components/ErrorBoundary'
import ErrorNotice from '../../components/ErrorNotice'
import { SettingsCard, SettingsButtonGroup } from '../../components/settings'
import { ACP_BACKEND_CONFIG_KEY, CLAUDE, KIRO, useAcpBackendChoices } from '../../hooks/useAcpBackendChoices'
import { i18nT } from '../../i18n/t'
import { clearCachedModels } from '../../providers/adapters/acp'
import { KiroSignInCard } from './KiroSignInCard'
import { KIRO_SIGN_IN_BACKEND } from './kiroSignInLink'

/** The config field the switch owns. Also the schema path the options are gated on. */
const CONFIG_KEY = ACP_BACKEND_CONFIG_KEY

/**
 * DOM id of the row that states a backend's status.
 *
 * The option button carries this as `aria-describedby`, so the reason a choice is
 * dead reaches a screen reader instead of living in visual proximity only. KIRO is
 * the empty string, hence the explicit `kiro` fallback — an id must not end in the
 * bare separator.
 */
const statusId = (value: string) => `agent-backend-status-${value || 'kiro'}`

/**
 * Developer > Agent Backend — pick which agent runs a session.
 *
 * ## Why this exists again
 *
 * The public core used to ship a multi-provider `ProviderPanel` and deleted it
 * when it collapsed to Kiro CLI only (`refactor(website): collapse provider layer
 * to KiroACP-only`). The backend kept all three agents wired the whole time, so
 * `agent.acp_backend` has been switchable with no way to switch it. This is that
 * control, minus the dead parts of the old panel (Bedrock model ids, a Claude Code
 * migration wizard, a provider enum that now has exactly one member).
 *
 * ## Why the choices come from the server
 *
 * Every agent the code knows about is listed, but only the ones this build can
 * actually run are selectable — that set is read from `GET /api/config/schema`
 * (`enumValues`), which the backend resolves per request from
 * `acp_backends.selectable_backend_values()`, the same owner
 * `PATCH /api/config/kirocrew` validates against. So the enabled options and the
 * values the wire accepts cannot disagree, and a build that ships another agent
 * lights it up here with no frontend change.
 *
 * That last clause is why `candidates` is a union of server answers rather than a
 * list of ids written here. An earlier revision filtered a hard-coded
 * `[KIRO, CLAUDE, KAS]` by the schema, which narrows correctly and can never widen —
 * so an agent an edition registered through `register_selectable_backend` was
 * selectable on the wire and invisible in the only control that sets it. Ids this
 * frontend has no translated name for render under their `policy_id`.
 *
 * ## Why there is a SECOND gate, and why it is allowed to say nothing
 *
 * The schema answers a build/edition-and-policy question — can this gateway serve
 * that agent at all. It cannot answer the machine question: whether the harness's
 * components are actually installed here. So a build that ships an agent lit the
 * option up whether or not the binary existed, and a user could neither see why it
 * was dead nor be told what to install. `GET /api/acp-backends` supplies that
 * second fact per backend, and the two compose: an option is dead when this build
 * will not serve it OR this machine is missing it.
 *
 * The probe has THREE answers and the third is load-bearing. `unknown` means the
 * check itself failed, and it leaves the option ENABLED — collapsing it onto
 * `missing` would tell someone to run a global install for something they may
 * already have. The same fail-open applies to the query being in flight, having
 * failed, or the endpoint answering 403 (non-owner) or 404 (older gateway): all of
 * those are absent information, not a verdict, so gating falls back to the schema
 * alone and behaves exactly as it did before this endpoint existed. Nothing here
 * flashes disabled and then live. The owner `PATCH` allowlist is the real gate, so
 * an optimistic enable can only ever cost one visible refusal, while an optimistic
 * DISABLE costs a user a control they were entitled to and an install they did not
 * need.
 *
 * ## Why each row says so little
 *
 * An earlier revision wrote a prose sentence per agent claiming what each one
 * supports — sandboxing, shared processes, mid-turn steer, subagent progress.
 * Those claims were not measured anywhere; they were asserted here, in the view
 * layer, where nothing can contradict them. They were wrong in the ways
 * unmeasured claims usually are.
 *
 * The status line per row is therefore limited to what this build can actually
 * establish, and the vocabulary is taken from the ACP-adapter card rather than
 * invented again: `Default. All features supported.` for the backend whose
 * descriptor is all-supported, `Experimental` for one that is not, and a
 * not-enabled line for one this build cannot run. Per-capability detail
 * (which feature is supported, degraded, or unverified per backend) needs the
 * descriptor table that owns those facts and is deliberately NOT restated here.
 *
 * The two probe lines (missing components, and check-failed) are the exception
 * that proves the rule rather than a relaxation of it: they are not claims about
 * what a backend supports, they are a measurement the server took on this machine
 * and named. They say only what was measured — which components are absent, and
 * the command that installs them when there is one to give.
 *
 * Deliberately NOT under `pages/settings/`: `gen-settings-registry.mjs` scans that
 * directory, and indexing an agent switch into Settings search would advertise it
 * as an ordinary preference — it changes which agent binary runs.
 */
export function AgentBackendTab() {
  const qc = useQueryClient()
  const [saveError, setSaveError] = useState('')
  // The one derivation of what is on offer, shared with the New Chat menu's
  // per-session rows (`useAcpBackendChoices`): both controls read the same
  // schema and probe answers, so they cannot disagree about which agents a
  // session may run on.
  const {
    current,
    currentLoading,
    currentError,
    refetchCurrent,
    probe,
    visible,
    disabledOption,
    nameOf,
    iconOf,
  } = useAcpBackendChoices()

  const patchMut = useMutation({
    mutationFn: (value: string) => api.patchConfig(CONFIG_KEY, value),
    onSuccess: () => {
      setSaveError('')
      qc.invalidateQueries({ queryKey: ['kirocrewConfig'] })
      // The model list is the NEW backend's now. `/api/models` re-reads
      // `agent.acp_backend` on every call, so the server side needs no restart;
      // only the frontend cache did, because `['available-models']` is refetched
      // in exactly one other place — a spawned session (`useWebSocket`'s
      // `activity_event`) — and the global `staleTime: Infinity` plus the
      // self-heal poll stopping after one live success mean nothing else ever
      // re-asks. That is why the picker looked like it needed a gateway restart:
      // the restart was just the next session spawn.
      //
      // `resetQueries`, not `invalidateQueries`: invalidate keeps the OLD
      // backend's rows on screen until the refetch lands, and a cold
      // `--list-models` spawn can take the gateway's full 10s. A pick in that
      // window writes an id the new backend rejects. Reset drops the data to
      // `undefined` first, so every picker shows the auto-only placeholder for
      // those seconds, then refetches. Drop the last-good localStorage list
      // FIRST for the same reason: a failing first fetch must degrade to
      // auto-only, not to the old backend's ids.
      clearCachedModels()
      qc.resetQueries({ queryKey: ['available-models'] })
    },
    // No optimistic write and no local mirror of the value: the button group reads
    // straight from the query, so a rejected PATCH needs no revert — the cache was
    // never moved off the server's answer.
    onError: () => setSaveError(i18nT('pages.developer.agentBackendTab.could_not_save_the_agent_backend')),
  })

  if (currentLoading) {
    return (
      <div className="text-muted text-sm py-12 text-center">
        {i18nT('pages.developer.agentBackendTab.loading_configuration')}
      </div>
    )
  }

  /**
   * A failed read is NOT the default value.
   *
   * `?? KIRO` is right for a config that genuinely omits the key — the shipped
   * default really is Kiro CLI. It is wrong for a read that FAILED: the value is
   * then unknown, and defaulting paints Kiro CLI as the pressed option, so an
   * operator running KAS is shown the wrong agent by a control that looks live.
   * Offer the retry instead of guessing.
   */
  if (currentError) {
    return (
      <div className="py-12 text-center">
        <div className="text-muted text-sm">
          {i18nT('pages.developer.agentBackendTab.could_not_load_the_agent_backend')}
        </div>
        <button
          type="button"
          className="mt-3 text-[13px] px-3 py-[5px] rounded-md border border-border bg-bg-elevated text-text-strong cursor-pointer"
          onClick={refetchCurrent}
        >
          {i18nT('pages.developer.agentBackendTab.retry')}
        </button>
      </div>
    )
  }

  /**
   * A standing caveat about the harness itself, independent of whether it is
   * installed. Unlike `status`, this does not change with the probe.
   *
   * ## Tool gating, which is stated here
   *
   * The DEFAULT path is gated: Claude asks, `claude-agent-acp` turns that into
   * `session/request_permission`, and Crew's own approval path decides. What escapes
   * is narrower and worth stating precisely -- a tool ALREADY pre-approved in Claude's
   * own settings never asks at all, because the SDK approves an allow-rule match
   * before consulting the client. Those settings include a `.claude/settings.json`
   * inside the project directory, which is the copy an operator did not write.
   *
   * That is documented, intended Claude behaviour rather than a defect here, but it
   * means the guarantee differs per harness. An operator choosing between harnesses is
   * choosing between governance models, so the panel names the difference instead of
   * letting them find it in a shell command that never asked. It is a TOOL-GATING
   * disclosure and not an auth one, so nothing below replaces it.
   *
   * Which is why this returns a LIST rather than one string. Claude is the harness
   * that carries both -- its tool gating has the caveat above AND it signs in through
   * its own credential file -- and an earlier revision returned early on the gating
   * line, so the one harness with two facts to state showed one of them.
   *
   * ## Signing in, which the SERVER states
   *
   * `auth.sign_in_remedy` arrives as a finished sentence and is rendered verbatim;
   * `auth.signs_in_separately` decides whether it is rendered at all, because a
   * harness that authenticates through Crew's own identity store has no separate
   * sign-in to finish. Absent `auth` says nothing, like every other absent probe
   * field.
   *
   * It is NOT translated, and that is the trade rather than an oversight. A
   * translated per-harness sentence is, by construction, a per-harness edit to
   * thirteen locale files, so the harness that needs the sentence most -- one an
   * edition registered and this frontend has never heard of -- is exactly the one
   * that would get no sentence at all. An untranslated remedy that is CORRECT beats
   * a translated one nobody adds.
   *
   * This also finishes the pattern the option list already follows: `candidates` is
   * a union of server answers rather than ids written here, and `nameOf` falls back
   * to the wire id when this frontend has no translated name. The `value === CODEX`
   * branch this replaces was the panel's last per-harness literal. Now the server
   * names a harness and states its remedy, and adding one costs no edit here.
   *
   * Still a caveat and not a probe line, deliberately. A measurement here would gate
   * the control -- `missing` disables the chip -- and the paths that authenticate a
   * harness are not all checkable: an ambient key, a relocated config home, an
   * adapter carrying its own configuration. Each of those is an operator whose switch
   * we would have disabled while they were already signed in, which the probe module
   * names as the more expensive mistake. A standing sentence cannot be wrong in that
   * direction.
   */
  const caveats = (value: string): string[] => {
    const lines: string[] = []
    if (value === CLAUDE)
      lines.push(i18nT('pages.developer.agentBackendTab.claude_uses_its_own_permissions'))
    const auth = probe(value)?.auth
    if (auth?.signs_in_separately) lines.push(auth.sign_in_remedy)
    return lines
  }



  /**
   * The one status line a row carries, derived rather than authored per agent.
   *
   * The order is strict, because the reasons are not equally actionable. There is no
   * not-selectable line: such an agent is not rendered at all, so every line here
   * describes something the reader can act on. `missing` comes first because it is the
   * one line that tells the user what to DO, and it names the command only when the
   * server had one to give. `unknown` follows and must never read as missing; it
   * reports a failed check, not an absent binary. Only then do the pre-existing
   * default/experimental lines apply. KIRO is the all-supported descriptor, so it gets
   * that sentence; anything else is not, so it gets `Experimental` rather than a claim.
   */
  const status = (value: string): string => {
    const row = probe(value)
    if (row?.installed === 'missing') {
      const components = row.missing_components.join(', ')
      return row.install_command
        ? i18nT('pages.developer.agentBackendTab.missing_components_with_command', {
            components,
            command: row.install_command,
          })
        : i18nT('pages.developer.agentBackendTab.missing_components', { components })
    }
    if (row?.installed === 'unknown') return i18nT('pages.developer.agentBackendTab.install_check_failed')
    // AFTER the missing/unknown lines and BEFORE the descriptor lines: this row
    // has a positive install verdict, so it would otherwise fall through to
    // `Experimental` and say nothing about why the option is dead.
    if (row?.restart_required)
      return i18nT('pages.developer.agentBackendTab.installed_restart_required')
    if (value === KIRO) return i18nT('pages.developer.agentBackendTab.default_all_features_supported')
    return i18nT('pages.developer.agentBackendTab.experimental')
  }

  return (
    <>
      <ErrorNotice message={saveError} onDismiss={() => setSaveError('')} />
      <SettingsCard>
        <SettingsButtonGroup
          label={i18nT('pages.developer.agentBackendTab.agent_backend')}
          description={i18nT('pages.developer.agentBackendTab.new_sessions_use_this_agent_a_session_that_is_al')}
          configKey={CONFIG_KEY}
          value={current}
          disabled={patchMut.isPending}
          options={visible.map(value => ({
            value,
            label: nameOf(value),
            icon: iconOf(value),
            disabled: disabledOption(value),
            describedById: statusId(value),
          }))}
          // `SettingsButtonGroup` fires for the pressed option too, and a PATCH
          // that writes the value already stored still resolves successfully —
          // which would run `onSuccess` and reset the model list, blanking every
          // picker and spawning `--list-models` for a backend that did not
          // change. Only a real change is a save.
          onChange={v => { if (v !== current) patchMut.mutate(v) }}
        />
        {/* One line per agent the panel offers — the reader is choosing BETWEEN them,
            so showing only the selected one's status would hide the very comparison
            the control is for. Agents this deployment may not select are absent from
            `visible`, so they carry no line either. */}
        <dl className="mt-2 space-y-1.5">
          {visible.map(value => (
            <div key={value} className="flex gap-2 text-[11px] leading-relaxed">
              <dt className={`shrink-0 font-semibold ${value === current ? 'text-text-strong' : 'text-muted'}`}>
                {nameOf(value)}
              </dt>
              <dd
                id={statusId(value)}
                className={`m-0 ${disabledOption(value) ? 'text-warn' : 'text-muted'}`}
              >
                {status(value)}
                {caveats(value).map(line => (
                  <div key={line} className="mt-0.5 text-muted">
                    {line}
                  </div>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        {/* The one thing the per-row lines cannot say. A managed fleet can bound
            this set through the `agent_backend` governance policy, and that policy
            is read once when the gateway starts — so an operator who edits it and
            sees no change here is not looking at a bug. Nothing in the UI can
            detect a not-yet-applied policy edit (that would mean reading the
            trust-root policy on a request path, which the harness-parity rules
            forbid), so stating the semantics is the honest substitute. */}
        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          {i18nT('pages.developer.agentBackendTab.set_is_fixed_at_gateway_start')}
        </p>
      </SettingsCard>
      {/* Kiro sign-in, under the switch that gives it a purpose. The identity the
          card stores is consumed by the KAS relay alone
          (`ACP_BACKENDS_HOST_AUTH_CALLBACK`), so the card is offered exactly when
          KAS is: on a build or policy that hides that option there is nothing to
          sign in for, and a chooser there would be a sign-in to nothing. Keyed on
          `visible` — the same set the rows above render — so the switch and the
          card cannot disagree about whether KAS is on offer. Gated on KAS being
          OFFERED rather than SELECTED, so the user can sign in first and switch
          second instead of paying one "not signed in" turn to find the card.
          Isolated so a throwing card cannot take the switch down with it. */}
      {visible.includes(KIRO_SIGN_IN_BACKEND) && (
        <ErrorBoundary scope="developer-kiro-sign-in" fallback={null}>
          <KiroSignInCard />
        </ErrorBoundary>
      )}
    </>
  )
}
