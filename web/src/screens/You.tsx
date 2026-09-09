import { getToken, setToken } from '@/api/client'
import { listMemories, listWeights } from '@/api/endpoints'
import { qk } from '@/api/keys'
import { Page } from '@/components/Page'
import { ScreenHeader } from '@/components/ScreenHeader'
import { COST_DISPLAY_LABELS, COST_DISPLAY_MODES } from '@/lib/costDisplay'
import { formatKg, latestWeight } from '@/lib/weight'
import { useUi } from '@/store/ui'
import { BrainIcon, ChevronIcon, DollarIcon, KeyIcon, ScaleIcon, Spinner } from '@/theme/icons'
import { accent, label, radius, surface, systemBlue, withAlpha } from '@/theme/tokens'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'

// Port of CalTracker/YouView.swift, cut back to what is real.
//
// Dropped: the hard-coded "Alex Tanaka" profile card with a chevron that led
// nowhere, the fake Daily-targets rows whose "Edit" was static text, the weekly
// schedule captioned "Tap a day to swap" with no gesture attached, an Apple
// Health toggle bound to state nothing read, the inert About / Notifications /
// Privacy rows, and the "mocked LLM" footer. The Local/Remote server picker
// goes too: the app is served from the same origin as its API.

export function You() {
  const navigate = useNavigate()
  const costDisplay = useUi((s) => s.costDisplay)
  const setCostDisplay = useUi((s) => s.setCostDisplay)

  const memoriesQuery = useQuery({ queryKey: qk.memories, queryFn: listMemories })
  const weightsQuery = useQuery({ queryKey: qk.weights, queryFn: () => listWeights() })

  const latest = latestWeight((weightsQuery.data ?? []).map((w) => ({ date: w.date, kg: w.kg })))
  const token = getToken()

  return (
    <Page>
      <ScreenHeader
        title="Профиль"
        trailing={memoriesQuery.isFetching || weightsQuery.isFetching ? <Spinner /> : null}
      />

      {/* Grouped into blocks so a section label always travels with its card.
          Each block is a flex column with the same gap the page uses, so on a
          phone the run of children is spaced exactly as it was before the grid
          existed; above 1024px the blocks pair up into two columns. */}
      <div className="card-row">
        <div className="card-block">
          <NavCard
            to="/you/weight"
            icon={<ScaleIcon size={15} />}
            tint={accent}
            title="Вес"
            subtitle={
              weightsQuery.isLoading
                ? 'Загружаю…'
                : latest
                  ? `${formatKg(latest.kg)} кг`
                  : 'Данных пока нет'
            }
          />
        </div>

        <div className="card-block">
          <SectionLabel>Ассистент</SectionLabel>
          <NavCard
            to="/you/memories"
            icon={<BrainIcon size={15} />}
            tint="#BF5AF2"
            title="Память"
            subtitle={
              memoriesQuery.isLoading
                ? 'Загружаю…'
                : `${memoriesQuery.data?.length ?? 0} ${plural(memoriesQuery.data?.length ?? 0)}`
            }
          />
        </div>

        <div className="card-block">
          <Card>
            <Row
              icon={<DollarIcon size={15} />}
              tint="#30D158"
              title="Стоимость запросов"
              subtitle="Показывать над ответами ассистента"
            />
            <div style={{ display: 'flex', gap: 4, padding: '0 14px 14px' }}>
              {COST_DISPLAY_MODES.map((mode) => {
                const active = mode === costDisplay
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setCostDisplay(mode)}
                    style={{
                      flex: 1,
                      border: 0,
                      borderRadius: 8,
                      background: active ? surface.subtle : 'transparent',
                      color: active ? label.primary : label.secondary,
                      fontWeight: active ? 600 : 400,
                      fontSize: 12,
                      padding: '7px 4px',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {COST_DISPLAY_LABELS[mode]}
                  </button>
                )
              })}
            </div>
          </Card>
        </div>

        <div className="card-block">
          <SectionLabel>Доступ</SectionLabel>
          <Card>
            <Row
              icon={<KeyIcon size={15} />}
              tint={systemBlue}
              title="Токен"
              subtitle={maskToken(token)}
            />
            <div style={{ padding: '0 14px 14px' }}>
              <button
                type="button"
                onClick={() => {
                  setToken('')
                  navigate('/login', { replace: true })
                }}
                style={{
                  border: 0,
                  borderRadius: radius.field,
                  background: withAlpha('#FF453A', 0.16),
                  color: '#FF453A',
                  fontWeight: 600,
                  fontSize: 13,
                  padding: '9px 12px',
                  cursor: 'pointer',
                }}
              >
                Выйти
              </button>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  )
}

/** `ft_1a2b…9f8e`, enough to tell two tokens apart without exposing one. */
function maskToken(token: string): string {
  if (!token) return 'не задан'
  if (token.length <= 12) return token
  return `${token.slice(0, 7)}…${token.slice(-4)}`
}

function plural(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'сохранённый факт'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'сохранённых факта'
  return 'сохранённых фактов'
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontWeight: 600,
        fontSize: 12.5,
        color: label.secondary,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        paddingLeft: 4,
      }}
    >
      {children}
    </span>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section style={{ background: surface.card, borderRadius: radius.card }}>{children}</section>
  )
}

function Row({
  icon,
  tint,
  title,
  subtitle,
}: {
  icon: React.ReactNode
  tint: string
  title: string
  subtitle: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14 }}>
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: radius.iconTile,
          background: withAlpha(tint, 0.18),
          color: tint,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span style={{ fontWeight: 400, fontSize: 16 }}>{title}</span>
        <span
          className="tnum"
          style={{
            fontWeight: 400,
            fontSize: 12.5,
            color: label.secondary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {subtitle}
        </span>
      </span>
    </div>
  )
}

function NavCard({
  to,
  icon,
  tint,
  title,
  subtitle,
}: {
  to: string
  icon: React.ReactNode
  tint: string
  title: string
  subtitle: string
}) {
  return (
    <Link
      to={to}
      style={{
        background: surface.card,
        borderRadius: radius.card,
        textDecoration: 'none',
        color: label.primary,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <Row icon={icon} tint={tint} title={title} subtitle={subtitle} />
      </span>
      <span style={{ color: withAlpha('#EBEBF5', 0.3), display: 'flex', paddingRight: 14 }}>
        <ChevronIcon dir="right" size={13} />
      </span>
    </Link>
  )
}
