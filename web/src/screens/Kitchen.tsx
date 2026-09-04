import { CalorieMeter } from '@/components/CalorieMeter'
import { ChatBubble, TypingBubble } from '@/components/ChatBubble'
import { MacroPie } from '@/components/MacroPie'
import { ScreenHeader } from '@/components/ScreenHeader'
import { MacroRing } from '@/components/ring/MacroRing'
import { RingStack } from '@/components/ring/RingStack'
import { OVERAGE_END_T } from '@/components/ring/ringColor'
import {
  CHIP_BG_ALPHA,
  dayTypeTint,
  dietDayColor,
  palette,
  singleRingSpec,
  surface,
  withAlpha,
} from '@/theme/tokens'
import { useState } from 'react'

// Component sandbox. This is the tool for the pixel-fidelity pass: open it
// next to the iOS simulator and compare state by state. Dev-only — the route
// is not registered in production builds.

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: surface.card,
        borderRadius: 18,
        padding: 16,
        marginBottom: 14,
      }}
    >
      <h2
        style={{
          font: '600 13px system-ui',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          color: 'rgba(235,235,245,0.6)',
          margin: '0 0 14px',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
    {children}
  </div>
)

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ textAlign: 'center' }}>
      {children}
      <div style={{ font: '500 11px system-ui', color: 'rgba(235,235,245,0.6)', marginTop: 6 }}>
        {label}
      </div>
    </div>
  )
}

function Chip({ label: text, tint }: { label: string; tint: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        font: '600 12.5px system-ui',
        color: tint,
        background: withAlpha(tint, CHIP_BG_ALPHA),
        borderRadius: 999,
        padding: '6px 11px',
      }}
    >
      {text}
    </span>
  )
}

// History rows and the chat macro strip show three INDEPENDENT rings side by
// side, not a nested stack — at those sizes nesting collapses the innermost
// ring to a radius narrower than its own stroke.
function MacroRow({ spec }: { spec: { size: number; strokeWidth: number } }) {
  const values = [0.78, 0.54, 1.14] as const
  const stops = [palette.protein, palette.carbs, palette.fat] as const
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {values.map((value, i) => (
        <MacroRing
          key={`${spec.size}-${i}-${value}`}
          value={value}
          stops={stops[i]!}
          size={spec.size}
          strokeWidth={spec.strokeWidth}
        />
      ))}
    </div>
  )
}

function Pie({ protein, carbs, fat }: { protein: number; carbs: number; fat: number }) {
  return (
    <MacroPie
      protein={protein}
      carbs={carbs}
      fat={fat}
      proteinColor={palette.protein[1]}
      carbsColor={palette.carbs[1]}
      fatColor={palette.fat[1]}
      size={28}
    />
  )
}

export function Kitchen() {
  const [live, setLive] = useState(0.62)

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '8px 16px 24px' }}>
      <div style={{ marginBottom: 14 }}>
        <ScreenHeader
          title="Песочница"
          subtitle="Пн, 3 сент"
          trailing={<Chip label="Тренировочный день" tint={dayTypeTint.training} />}
        />
      </div>

      <Card title="Кольцо — заполнение">
        <Row>
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <Labelled key={v} label={`${Math.round(v * 100)}%`}>
              <MacroRing value={v} stops={palette.protein} size={92} strokeWidth={9} />
            </Labelled>
          ))}
        </Row>
      </Card>

      {/* The overage ramp is the single hardest thing to get right: past 100%
          the colour must slide into systemRed over the first 25° of lap two. */}
      <Card title="Кольцо — перебор">
        <Row>
          {[1, 1.03, OVERAGE_END_T, 1.15, 1.6, 2.3].map((v) => (
            <Labelled key={v} label={`${Math.round(v * 100)}%`}>
              <MacroRing value={v} stops={palette.fat} size={92} strokeWidth={9} />
            </Labelled>
          ))}
        </Row>
      </Card>

      <Card title="Палитра Aurora">
        <Row>
          {(['calories', 'protein', 'carbs', 'fat'] as const).map((k) => (
            <Labelled key={k} label={k}>
              <MacroRing value={0.78} stops={palette[k]} size={92} strokeWidth={9} />
            </Labelled>
          ))}
        </Row>
      </Card>

      <Card title="Стопка колец — размеры с реальных экранов">
        <Row>
          <Labelled label="Today 156/13/3">
            <RingStack
              rings={[
                { value: 0.78, stops: palette.protein },
                { value: 0.54, stops: palette.carbs },
                { value: 1.14, stops: palette.fat },
              ]}
              size={156}
              strokeWidth={13}
              gap={3}
            />
          </Labelled>
          <Labelled label="История 26/3.5 — три отдельных">
            <MacroRow spec={singleRingSpec.historyRow} />
          </Labelled>
          <Labelled label="Чат 36/4.5 — три отдельных">
            <MacroRow spec={singleRingSpec.chatStrip} />
          </Labelled>
          <Labelled label="без цели">
            <RingStack
              rings={[
                { value: 0, stops: palette.protein, dimmed: true },
                { value: 0, stops: palette.carbs, dimmed: true },
                { value: 0, stops: palette.fat, dimmed: true },
              ]}
              size={56}
              strokeWidth={6}
              gap={2}
            />
          </Labelled>
        </Row>
      </Card>

      <Card title="Анимация — потяни ползунок">
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          <MacroRing value={live} stops={palette.carbs} size={120} strokeWidth={12} />
          <div style={{ flex: 1 }}>
            <input
              type="range"
              min={0}
              max={2.5}
              step={0.01}
              value={live}
              onChange={(e) => setLive(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#ff9500' }}
            />
            <div
              className="tnum"
              style={{ font: '700 22px system-ui', marginTop: 8, textAlign: 'center' }}
            >
              {Math.round(live * 100)}%
            </div>
          </div>
        </div>
      </Card>

      <Card title="Калорийная шкала — large, под целью">
        <CalorieMeter
          current={1748}
          goal={2650}
          stops={palette.calories}
          accessory={<Chip label="Тренировочный день" tint={dayTypeTint.training} />}
        />
      </Card>

      <Card title="Калорийная шкала — large, перебор">
        <CalorieMeter
          current={2900}
          goal={2650}
          stops={palette.calories}
          accessory={<Chip label="День отдыха" tint={dayTypeTint.rest} />}
        />
      </Card>

      <Card title="Калорийная шкала — medium и small">
        <CalorieMeter current={1100} goal={2250} stops={palette.calories} size="medium" />
        <div style={{ height: 18 }} />
        <CalorieMeter current={400} goal={2650} stops={palette.calories} size="small" />
      </Card>

      <Card title="MacroPie — разбивка по граммам">
        <Row>
          <Labelled label="20/20/20">
            <Pie protein={20} carbs={20} fat={20} />
          </Labelled>
          <Labelled label="40/10/5">
            <Pie protein={40} carbs={10} fat={5} />
          </Labelled>
          <Labelled label="только белок">
            <Pie protein={30} carbs={0} fat={0} />
          </Labelled>
          <Labelled label="нет данных">
            <Pie protein={0} carbs={0} fat={0} />
          </Labelled>
        </Row>
      </Card>

      <Card title="Пузыри чата">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ChatBubble isUser text="латте с овсяным молоком и банан" />
          <ChatBubble
            isUser={false}
            text={'## Записал\n- 1 латте (`овсяное`)\n- 1 **банан**\nОсталось *900* ккал.'}
          />
          <ChatBubble isUser={false} text="Ссылка: [документация](https://example.com)" />
          <TypingBubble />
        </div>
      </Card>

      <Card title="Цвета дня">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {Object.entries(dietDayColor).map(([name, hex]) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: hex,
                  boxShadow: '0 0 0 0.5px rgba(255,255,255,0.14)',
                }}
              />
              <span style={{ font: '500 12px system-ui', color: 'rgba(235,235,245,0.6)' }}>
                {name}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Поверхности">
        {(
          [
            ['card #1C1C1C', surface.card],
            ['input #121212', surface.input],
            ['bubble #2E2E2E', surface.bubble],
            ['elevated #292929', surface.elevated],
            ['track systemGray 16%', surface.track],
          ] as const
        ).map(([name, value]) => (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <span
              style={{
                width: 40,
                height: 24,
                borderRadius: 6,
                background: value,
                outline: '0.5px solid rgba(255,255,255,0.08)',
              }}
            />
            <span style={{ font: '400 12px ui-monospace, monospace' }}>{name}</span>
          </div>
        ))}
      </Card>
    </div>
  )
}
