/**
 * Web half of dsh-plugin-memory.
 *
 * Loaded by the Harness Client module loader: the factory is pure, React comes
 * from the browser module table, and the platform register happens in apply()
 * so unload can dispose it. The page is a single settings section — it is the
 * user-visible surface for the three-state health model and for the two human
 * gates of habit learning. It talks to the Host half through the plugin's own
 * read/write HTTP routes, so a missing route degrades to a static "unavailable"
 * card instead of breaking the settings panel.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const POLL_MS = 5000
    const ENDPOINT = '/dsh-memory/status'
    const HABIT_ENDPOINT = '/dsh-memory/habits'

    function card(style) {
      return {
        border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.25))',
        borderRadius: 10,
        padding: '14px 16px',
        marginBottom: 12,
        background: 'var(--dsw-alias-bg-elevated, transparent)',
        ...style,
      }
    }

    function badge(tone) {
      const color =
        tone === 'active'
          ? 'var(--dsw-alias-success, #16a34a)'
          : tone === 'degraded'
            ? 'var(--dsw-alias-warning, #d97706)'
            : 'var(--dsw-alias-danger, #dc2626)'
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '1px 8px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
            color: '#fff',
            background: color,
            marginRight: 8,
          },
        },
        String(tone || 'unavailable').toUpperCase(),
      )
    }

    function row(label, value) {
      return h(
        'div',
        { style: { display: 'flex', gap: 12, margin: '3px 0', fontSize: 13 } },
        h('span', { style: { minWidth: 150, opacity: 0.7 } }, label),
        h('span', { style: { fontFamily: 'var(--dsw-font-mono, monospace)', wordBreak: 'break-all' } }, String(value)),
      )
    }

    function button(label, onClick, disabled) {
      return h(
        'button',
        {
          type: 'button',
          disabled: Boolean(disabled),
          onClick,
          style: {
            marginRight: 8,
            padding: '4px 12px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.35))',
            background: 'transparent',
            color: 'inherit',
            cursor: disabled ? 'default' : 'pointer',
            fontSize: 13,
          },
        },
        label,
      )
    }

    function useStatus() {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (alive) {
              setStatus(body)
              setError(null)
            }
          } catch (cause) {
            if (alive) setError(String(cause && cause.message ? cause.message : cause))
          }
        }
        load()
        const timer = setInterval(load, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])
      return { status, error }
    }

    function useHabits() {
      const [review, setReview] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [seq, setSeq] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        fetch(HABIT_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'list' }),
        })
          .then((response) => response.json())
          .then((body) => {
            if (!alive) return
            setReview(body)
            setError(body && body.ok === false ? body.warning || 'habit review unavailable' : null)
          })
          .catch((cause) => {
            if (alive) setError(String(cause && cause.message ? cause.message : cause))
          })
        return () => {
          alive = false
        }
      }, [seq])
      return { review, error, refresh: () => setSeq((value) => value + 1) }
    }

    function habitAction(action, id) {
      return fetch(HABIT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, id }),
      })
        .then((response) => response.json())
        .catch(() => ({ ok: false, error: 'habit request failed' }))
    }

    function HabitSection(props) {
      const { review, error, onMutated } = props
      const candidates = (review && review.candidates) || []
      const profiles = (review && review.profiles) || []
      const [message, setMessage] = React.useState('')
      const act = async (action, id) => {
        const result = await habitAction(action, id)
        setMessage(JSON.stringify(result))
        if (onMutated) onMutated()
      }
      return h(
        'div',
        { style: card() },
        h('div', { style: { fontWeight: 600, marginBottom: 8 } }, 'Habit review (two human gates)'),
        error && h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-warning, #d97706)', marginBottom: 8 } }, `Habit review unavailable: ${error}`),
        candidates.length === 0
          ? h('div', { style: { fontSize: 13, opacity: 0.7 } }, 'No pending candidates. Candidates appear after three deterministic corrections in one session.')
          : candidates.map((candidate) =>
              h(
                'div',
                { key: candidate.id, style: { padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.15))' } },
                h('div', { style: { fontSize: 13, fontWeight: 600 } }, candidate.pattern || candidate.id),
                h(
                  'div',
                  { style: { fontSize: 12, opacity: 0.7, margin: '2px 0 6px' } },
                  `status=${candidate.status} · sessions=${(candidate.sessions || []).length} · judgedBy=${candidate.judgedBy || 'rule'}`,
                ),
                h(
                  'div',
                  null,
                  candidate.status === 'pending'
                    ? [
                        button('Confirm habit (gate 1)', () => act('confirm', candidate.id)),
                        button('Discard', () => act('discard', candidate.id)),
                      ]
                    : candidate.status === 'confirmed'
                      ? [button('Promote to auto (gate 2)', () => act('promote', candidate.id), (candidate.sessions || []).length < 2)]
                      : null,
                ),
              ),
            ),
        profiles.length > 0 &&
          h(
            'div',
            { style: { marginTop: 10 } },
            h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 4 } }, 'Habit profiles'),
            profiles.map((profile) =>
              h(
                'div',
                { key: profile.id, style: { fontSize: 13, margin: '4px 0' } },
                `${profile.pattern} — status=${profile.status} `,
                button('Delete', () => act('delete', profile.id)),
              ),
            ),
          ),
        message && h('div', { style: { fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: 11, marginTop: 8, opacity: 0.8 } }, message),
      )
    }

    function MemorySettingsPage() {
      const { status, error } = useStatus()
      const habits = useHabits()

      if (!status) {
        return h(
          'div',
          { style: { padding: 16, fontSize: 14 } },
          h('h2', { style: { margin: '0 0 8px' } }, 'Memory'),
          h('div', { style: { fontSize: 13, opacity: 0.8 } }, error ? `Status route unavailable: ${error}` : 'Loading memory status…'),
          error && h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 6 } }, 'Host half may be disabled; the memory tools still work without this page.'),
        )
      }

      const health = status.health || { status: 'unavailable', reasons: [] }
      const counts = status.counts || {}
      const budgets = status.budgets || {}
      const judge = status.judge || {}
      return h(
        'div',
        { style: { padding: 16 } },
        h('h2', { style: { margin: '0 0 12px' } }, 'Memory'),
        h(
          'div',
          { style: card() },
          h('div', { style: { marginBottom: 6 } }, badge(health.status), h('span', { style: { fontWeight: 600 } }, 'dsh-plugin-memory')),
          (health.reasons || []).length === 0
            ? h('div', { style: { fontSize: 13, opacity: 0.7 } }, 'All memory features are active.')
            : (health.reasons || []).map((reason) =>
                h('div', { key: `${reason.code}-${reason.scope}`, style: { fontSize: 13, color: 'var(--dsw-alias-warning, #d97706)', margin: '2px 0' } }, `[${reason.scope}] ${reason.code}: ${reason.message}`),
              ),
          status.warning && h('div', { style: { fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: 11, marginTop: 8, opacity: 0.8 } }, status.warning),
          h('div', { style: { marginTop: 10 } }, row('state file', (health.stateFile || status.stateFile || 'unknown'))),
        ),
        h(
          'div',
          { style: card() },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, 'Storage'),
          row('project', (status.stores && status.stores.project) || 'not in a repo'),
          row('global', (status.stores && status.stores.global) || 'unavailable'),
          row('habit', (status.stores && status.stores.habit) || 'unavailable'),
          row('entries', `project=${counts.project || 0} global=${counts.global || 0} habit=${counts.habit || 0}`),
        ),
        h(
          'div',
          { style: card() },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, 'Token budgets'),
          row('index lines / chars', `${budgets.indexMaxLines} / ${budgets.indexMaxChars}`),
          row('per recall', `topK=${budgets.recallMaxResults}, ${budgets.recallMaxCharsPerMemory} chars/item, ${budgets.recallMaxTotalChars} chars total`),
          row('session recall budget', `${budgets.recallSessionBudgetChars} chars`),
          row('offload threshold', `${budgets.unloadThresholdChars} chars`),
          row('index cache', `tier=${(status.cache && status.cache.tier) || 'n/a'} · hash=${(status.cache && status.cache.indexHash) || 'n/a'}`),
          row('LLM / judge', judge.enabled ? `judge ON (${judge.model})` : 'zero-LLM mode (judge off)'),
        ),
        h(HabitSection, { review: habits.review, error: habits.error, onMutated: () => habits.refresh() }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('settings.section', () => {
            return ctx.slots.register({ name: 'settings.section', id: 'dsh-memory', order: 60, label: 'Memory' }, MemorySettingsPage)
          })
        } catch (cause) {
          // Slot resolution is version-dependent: never break the settings UI.
          console.warn('[dsh-memory] settings slot unavailable; host tools still work', cause)
        }
      },
    }
  },
})
