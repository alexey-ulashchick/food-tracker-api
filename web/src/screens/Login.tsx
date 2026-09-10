import { ApiError, TOKEN_RE, getToken, setToken } from '@/api/client'
import { listMemories } from '@/api/endpoints'
import { EyeIcon } from '@/theme/icons'
import { accent, label, layout, radius, surface } from '@/theme/tokens'
import { useState } from 'react'
import { useNavigate } from 'react-router'

// Token entry. Deliberately the same shape as the Server card in YouView.swift:
// tokens are minted by scripts/issue-token.ts and pasted in by hand, so there is
// no sign-up flow to build. What is new here is that the token is checked
// against the API before it is accepted — the Swift app stored whatever was
// typed and only failed later, inside Chat.

type Status = { kind: 'idle' } | { kind: 'checking' } | { kind: 'error'; message: string }

export function Login() {
  const navigate = useNavigate()
  const [value, setValue] = useState(getToken())
  const [reveal, setReveal] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const trimmed = value.trim()
  const canSubmit = trimmed.length > 0 && status.kind !== 'checking'

  async function submit() {
    if (!canSubmit) return

    if (!TOKEN_RE.test(trimmed)) {
      setStatus({
        kind: 'error',
        message: 'Токен должен выглядеть как ft_ и 64 шестнадцатеричных символа.',
      })
      return
    }

    setStatus({ kind: 'checking' })
    // Store first: the request has to carry the token to be validated at all.
    setToken(trimmed)
    try {
      // Any authenticated endpoint proves the token; memories is the cheapest.
      await listMemories()
      navigate('/', { replace: true })
    } catch (err) {
      setToken('')
      const message =
        err instanceof ApiError && err.status === 401
          ? 'Сервер отклонил токен. Проверь, что он не отозван.'
          : 'Не удалось связаться с сервером. Попробуй ещё раз.'
      setStatus({ kind: 'error', message })
    }
  }

  return (
    <div className="outer-frame">
      <div
        className="page"
        // Deliberately overriding .page's desktop max-width from inline, which
        // beats the class: this page wants a form-width column, not the 1180px
        // content column the app's screens get.
        style={{
          maxWidth: 'var(--form-max)',
          margin: '0 auto',
        }}
      >
        <h1 style={{ fontWeight: 700, fontSize: 32, margin: '8px 0 0' }}>Cal Tracker</h1>
        <p style={{ fontWeight: 400, fontSize: 13.5, color: label.secondary, margin: 0 }}>
          Вставь токен доступа. Его выдаёт скрипт{' '}
          <code style={{ fontFamily: 'ui-monospace, monospace' }}>issue-token</code> на сервере.
        </p>

        <div
          style={{
            background: surface.card,
            borderRadius: radius.card,
            padding: layout.cardPadWide,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                if (status.kind === 'error') setStatus({ kind: 'idle' })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              type={reveal ? 'text' : 'password'}
              placeholder="ft_…"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              // A password field would otherwise invite the browser to save it
              // under the site's login, which this is not.
              autoComplete="off"
              style={{
                flex: 1,
                minWidth: 0,
                background: surface.input,
                border: 0,
                borderRadius: radius.field,
                color: label.primary,
                font: '400 12px ui-monospace, monospace',
                padding: '10px 12px',
              }}
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? 'Скрыть токен' : 'Показать токен'}
              style={{
                background: 'none',
                border: 0,
                color: label.secondary,
                padding: 6,
                cursor: 'pointer',
                display: 'flex',
              }}
            >
              <EyeIcon off={reveal} />
            </button>
          </div>

          {status.kind === 'error' ? (
            <span style={{ fontWeight: 400, fontSize: 12.5, color: '#FF453A' }}>
              {status.message}
            </span>
          ) : null}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            style={{
              background: canSubmit ? accent : surface.control,
              border: 0,
              borderRadius: radius.field,
              color: canSubmit ? '#000' : label.secondary,
              fontWeight: 600,
              fontSize: 15,
              padding: '11px 12px',
              cursor: canSubmit ? 'pointer' : 'default',
            }}
          >
            {status.kind === 'checking' ? 'Проверяю…' : 'Войти'}
          </button>
        </div>
      </div>
    </div>
  )
}
