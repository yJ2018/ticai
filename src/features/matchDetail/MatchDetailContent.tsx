import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { type DetailGroup, type DetailLineupTeam, type MatchDetailView } from './matchDetailView'

type MatchDetailContentProps = {
  view: MatchDetailView | null
  loading: boolean
  error: string
  fallback?: { homeTeam?: string; awayTeam?: string; league?: string }
}

const NAV_ITEMS = [
  { id: 'h2h', label: '交锋' },
  { id: 'form', label: '近况' },
  { id: 'injury', label: '伤停' },
  { id: 'lineup', label: '阵容' },
  { id: 'fixture', label: '赛程' },
  { id: 'table', label: '积分' },
  { id: 'shooter', label: '射手' },
] as const

type SectionId = (typeof NAV_ITEMS)[number]['id']

/**
 * 详情正文。PC 弹框和 H5 页面共用同一份，保证两端信息一致。
 *
 * 三件事：
 * 1. 加载中给等高的骨架屏，不闪空框、不跳高度；
 * 2. 顶部一条吸顶分区导航（弹框内容很长，光靠滚动很难找到阵容）；
 * 3. 每个板块标题带色条与计数，两侧对比用浅底色块分开，避免"一片糊"。
 *
 * 「没有的信息就空着」：每个板块都常驻，没数据时显示一行灰字，
 * 不用整块隐藏——用户能明确感知"这里本来有东西，只是暂时没有"。
 */
export function MatchDetailContent({ view, loading, error, fallback }: MatchDetailContentProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<SectionId>(NAV_ITEMS[0].id)

  useEffect(() => {
    if (!view) {
      return
    }

    const container = bodyRef.current?.closest('.md-dialog__body, .md-page__scroll')
    if (!(container instanceof HTMLElement)) {
      return
    }

    const update = () => {
      const anchor = container.getBoundingClientRect().top + 76
      let current: SectionId = NAV_ITEMS[0].id
      for (const item of NAV_ITEMS) {
        const node = document.getElementById(`md-sec-${item.id}`)
        if (node && node.getBoundingClientRect().top <= anchor) {
          current = item.id
        }
      }
      setActive(current)
    }

    update()
    container.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      container.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [view])

  const jumpTo = useCallback((id: SectionId) => {
    const node = document.getElementById(`md-sec-${id}`)
    if (!node) {
      return
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    node.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  }, [])

  if (loading) {
    return <MatchDetailSkeleton fallback={fallback} />
  }

  if (!view) {
    return (
      <div className="md-empty-state">
        <strong>
          {fallback?.homeTeam || '主队'} vs {fallback?.awayTeam || '客队'}
        </strong>
        <p>{error || '暂无对战数据'}</p>
        <p className="md-empty-state__hint">
          该场次可能还没抓取，或体彩未提供对阵数据。数据为空时不会做任何推测。
        </p>
      </div>
    )
  }

  const statusTone =
    view.statusLabel === '进行中'
      ? 'is-live'
      : view.statusLabel === '已结束'
        ? 'is-done'
        : view.statusLabel === '已取消'
          ? 'is-cancelled'
          : ''

  return (
    <div className="md-body" ref={bodyRef}>
      <header className="md-hero">
        <div className="md-hero__meta">
          <span className="md-hero__league">{view.league}</span>
          <span className="md-hero__kickoff">{view.kickoff}</span>
          <span className={`md-hero__status ${statusTone}`}>{view.statusLabel}</span>
        </div>
        <div className="md-hero__score">
          <span className="md-hero__team">{view.homeName}</span>
          <strong className={view.scoreText === 'VS' ? 'is-vs' : ''}>{view.scoreText}</strong>
          <span className="md-hero__team">{view.awayName}</span>
        </div>
        {view.htftText && (
          <div className="md-hero__foot">
            <span>半全场</span>
            <b>{view.htftText}</b>
          </div>
        )}
      </header>

      <nav className="md-nav" aria-label="板块导航">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`md-nav__chip ${active === item.id ? 'is-active' : ''}`}
            aria-current={active === item.id ? 'true' : undefined}
            onClick={() => jumpTo(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <Section id="h2h" title="历史交锋" sub={view.h2h.summary}>
        {view.h2h.items.length === 0 ? (
          <Empty />
        ) : (
          <>
            <div className="md-h2h__head" aria-hidden="true">
              <span>日期</span>
              <span>赛事</span>
              <span className="is-end">主队</span>
              <span className="is-center">比分</span>
              <span>客队</span>
              <span className="is-end">半场</span>
            </div>
            <ul className="md-list">
              {view.h2h.items.map((item, index) => (
                <li key={`${item.date}-${index}`} className="md-list__row">
                  <span className="md-list__date">{item.date}</span>
                  <span className="md-list__league">{item.league}</span>
                  <span className="md-list__home">{item.home}</span>
                  <b className="md-list__score">{item.score}</b>
                  <span className="md-list__away">{item.away}</span>
                  <span className="md-list__half">{item.half ? `半 ${item.half}` : ''}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section id="form" title="近期战绩">
        <div className="md-columns">
          <SideBlock group={view.recent.home}>
            {(item) => (
              <li key={`${item.date}-${item.home}-${item.away}`} className="md-form">
                <span className="md-list__date">{item.date}</span>
                <em className={`md-form__tag is-${item.tag || 'none'}`}>{item.tag || '-'}</em>
                <span className="md-match">
                  <span className="md-match__home">{item.home}</span>
                  <b className="md-match__score">{item.score}</b>
                  <span className="md-match__away">{item.away}</span>
                </span>
              </li>
            )}
          </SideBlock>
          <SideBlock group={view.recent.away}>
            {(item) => (
              <li key={`${item.date}-${item.home}-${item.away}`} className="md-form">
                <span className="md-list__date">{item.date}</span>
                <em className={`md-form__tag is-${item.tag || 'none'}`}>{item.tag || '-'}</em>
                <span className="md-match">
                  <span className="md-match__home">{item.home}</span>
                  <b className="md-match__score">{item.score}</b>
                  <span className="md-match__away">{item.away}</span>
                </span>
              </li>
            )}
          </SideBlock>
        </div>
      </Section>

      <Section id="injury" title="伤停">
        <div className="md-columns">
          <SideBlock group={view.injuries.home}>
            {(person) => (
              <li key={`${person.name}-${person.kind}`} className="md-injury">
                <span className="md-injury__name">{person.name}</span>
                {person.position && <span className="md-injury__pos">{person.position}</span>}
                <em className={person.kind === '停赛' ? 'is-suspend' : ''}>{person.kind}</em>
              </li>
            )}
          </SideBlock>
          <SideBlock group={view.injuries.away}>
            {(person) => (
              <li key={`${person.name}-${person.kind}`} className="md-injury">
                <span className="md-injury__name">{person.name}</span>
                {person.position && <span className="md-injury__pos">{person.position}</span>}
                <em className={person.kind === '停赛' ? 'is-suspend' : ''}>{person.kind}</em>
              </li>
            )}
          </SideBlock>
        </div>
      </Section>

      <Section id="lineup" title="阵容" sub={lineupSummary(view.lineup)}>
        <div className="md-columns">
          <LineupTeam team={view.lineup.home} name={view.homeName} />
          <LineupTeam team={view.lineup.away} name={view.awayName} />
        </div>
      </Section>

      <Section id="fixture" title="未来赛程">
        <div className="md-columns">
          <SideBlock group={view.upcoming.home}>
            {(item) => (
              <li key={`${item.date}-${item.home}-${item.away}`} className="md-fixture">
                <span className="md-list__date">
                  {item.date} {item.time}
                </span>
                <span className="md-match">
                  <span className="md-match__home">{item.home}</span>
                  <b className="md-match__score is-vs">vs</b>
                  <span className="md-match__away">{item.away}</span>
                </span>
                {item.league && <span className="md-list__league">{item.league}</span>}
              </li>
            )}
          </SideBlock>
          <SideBlock group={view.upcoming.away}>
            {(item) => (
              <li key={`${item.date}-${item.home}-${item.away}`} className="md-fixture">
                <span className="md-list__date">
                  {item.date} {item.time}
                </span>
                <span className="md-match">
                  <span className="md-match__home">{item.home}</span>
                  <b className="md-match__score is-vs">vs</b>
                  <span className="md-match__away">{item.away}</span>
                </span>
                {item.league && <span className="md-list__league">{item.league}</span>}
              </li>
            )}
          </SideBlock>
        </div>
      </Section>

      <Section id="table" title={view.table.tournament ? `积分榜 · ${view.table.tournament}` : '积分榜'}>
        {view.table.rows.length === 0 ? (
          <Empty />
        ) : (
          <table className="md-table">
            <thead>
              <tr>
                <th>球队</th>
                <th>排名</th>
                <th>场次</th>
                <th>积分</th>
              </tr>
            </thead>
            <tbody>
              {view.table.rows.map((row) => (
                <tr key={row.team}>
                  <td>{row.team}</td>
                  <td>{row.ranking}</td>
                  <td>{row.played}</td>
                  <td className="md-table__points">{row.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section id="shooter" title="射手">
        <div className="md-columns">
          <SideBlock group={view.shooters.home}>
            {(person) => (
              <li key={person.name} className="md-shooter">
                <span className="md-injury__name">{person.name}</span>
                <span className="md-shooter__stat">{person.goals} 球</span>
                {person.assists > 0 && <span className="md-shooter__stat is-assist">{person.assists} 助</span>}
              </li>
            )}
          </SideBlock>
          <SideBlock group={view.shooters.away}>
            {(person) => (
              <li key={person.name} className="md-shooter">
                <span className="md-injury__name">{person.name}</span>
                <span className="md-shooter__stat">{person.goals} 球</span>
                {person.assists > 0 && <span className="md-shooter__stat is-assist">{person.assists} 助</span>}
              </li>
            )}
          </SideBlock>
        </div>
      </Section>

      <p className="md-footnote">数据来自体彩公开接口与 500.com；没抓到的板块保持为空，不做推测。</p>
    </div>
  )
}

function lineupSummary(lineup: MatchDetailView['lineup']) {
  const sides = [lineup.home, lineup.away].filter((team): team is DetailLineupTeam => Boolean(team))
  if (sides.length === 0) {
    return ''
  }
  const confirmed = sides.every((team) => team.confirmed)
  return `${confirmed ? '官方名单' : '预计首发'}`
}

function Section({
  id,
  title,
  sub,
  children,
}: {
  id: SectionId
  title: string
  sub?: string
  children: ReactNode
}) {
  return (
    <section className="md-section" id={`md-sec-${id}`}>
      <div className="md-section__head">
        <h3>{title}</h3>
        {sub && <span>{sub}</span>}
      </div>
      {children}
    </section>
  )
}

function Empty() {
  return <p className="md-empty">暂无数据</p>
}

function SideBlock<T>({
  group,
  children,
}: {
  group: DetailGroup<T>
  children: (item: T) => ReactNode
}) {
  return (
    <div className="md-side">
      <div className="md-side__title">
        <span className="md-side__team">{group.teamName}</span>
        <span className="md-side__count">{group.items.length > 0 ? `${group.items.length} 条` : '0 条'}</span>
      </div>
      {group.items.length > 0 ? (
        <ul className="md-side__list">{group.items.map(children)}</ul>
      ) : (
        <p className="md-empty">暂无数据</p>
      )}
    </div>
  )
}

function LineupTeam({ team, name }: { team: DetailLineupTeam | null; name: string }) {
  if (!team) {
    return (
      <div className="md-side">
        <div className="md-side__title">
          <span className="md-side__team">{name}</span>
          <span className="md-side__count">
            <i className="md-tag">未公布</i>
          </span>
        </div>
        <p className="md-empty">赛前 1 小时左右公布，暂未抓到</p>
      </div>
    )
  }

  return (
    <div className="md-side">
      <div className="md-side__title">
        <span className="md-side__team">{team.teamName || name}</span>
        <span className="md-side__count">
          {team.formation && <i className="md-tag">{team.formation}</i>}
          <i className={`md-tag ${team.confirmed ? 'is-official' : 'is-guess'}`}>
            {team.confirmed ? '官方' : '预测'}
          </i>
        </span>
      </div>

      <ul className="md-lineup">
        {team.starters.map((player) => (
          <li key={`starter-${player.name}`} className="md-lineup__row">
            <em>{player.number || '-'}</em>
            <span>{player.name}</span>
            {player.position && <i>{player.position}</i>}
          </li>
        ))}
      </ul>

      {team.substitutes.length > 0 && (
        <details className="md-lineup__bench">
          <summary>替补 {team.substitutes.length} 人</summary>
          <ul className="md-lineup">
            {team.substitutes.map((player) => (
              <li key={`bench-${player.name}`} className="md-lineup__row">
                <em>{player.number || '-'}</em>
                <span>{player.name}</span>
                {player.position && <i>{player.position}</i>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function MatchDetailSkeleton({ fallback }: { fallback?: MatchDetailContentProps['fallback'] }) {
  return (
    <div className="md-body md-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="md-sr">正在加载对战数据…</span>

      <div className="md-skeleton__hero">
        <div className="md-skeleton__row">
          <span className="md-skeleton__bar" style={{ width: '4.6rem' }} />
          <span className="md-skeleton__bar" style={{ width: '5.4rem' }} />
          <span className="md-skeleton__bar" style={{ width: '3.2rem' }} />
        </div>
        <div className="md-skeleton__score">
          <span className="md-skeleton__bar is-team" />
          <span className="md-skeleton__bar is-vs" />
          <span className="md-skeleton__bar is-team" />
        </div>
        <p className="md-skeleton__hint">
          {fallback?.homeTeam || '主队'} vs {fallback?.awayTeam || '客队'} · 正在拉取交锋、伤停与阵容…
        </p>
      </div>

      <div className="md-skeleton__nav" aria-hidden="true">
        {[3.2, 2.8, 2.8, 2.8, 3.4].map((width, index) => (
          <span key={index} className="md-skeleton__bar is-chip" style={{ width: `${width}rem` }} />
        ))}
      </div>

      {[0, 1, 2, 3].map((section) => (
        <div className="md-skeleton__section" key={section} aria-hidden="true">
          <span className="md-skeleton__bar is-title" />
          {section % 2 === 1 ? (
            <div className="md-skeleton__cols">
              {[0, 1].map((side) => (
                <div className="md-skeleton__col" key={side}>
                  <span className="md-skeleton__bar" style={{ width: '5rem' }} />
                  {[0, 1, 2, 3].map((line) => (
                    <span key={line} className="md-skeleton__bar is-wide" />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="md-skeleton__lines">
              {[0, 1, 2, 3, 4].map((line) => (
                <div className="md-skeleton__line" key={line}>
                  <span className="md-skeleton__bar" style={{ width: '3.4rem' }} />
                  <span className="md-skeleton__bar is-wide" />
                  <span className="md-skeleton__bar" style={{ width: '2.6rem' }} />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
