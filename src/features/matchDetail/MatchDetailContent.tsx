import { type ReactNode } from 'react'

import { type DetailGroup, type MatchDetailView } from './matchDetailView'

type MatchDetailContentProps = {
  view: MatchDetailView | null
  loading: boolean
  error: string
  fallback?: { homeTeam?: string; awayTeam?: string; league?: string }
}

/**
 * 详情正文。PC 弹框和 H5 页面共用同一份，保证两端信息一致。
 *
 * 「没有的信息就空着」：每个板块都常驻，没数据时显示一行灰字，
 * 不用整块隐藏——用户能明确感知"这里本来有东西，只是暂时没有"。
 */
export function MatchDetailContent({ view, loading, error, fallback }: MatchDetailContentProps) {
  if (loading) {
    return (
      <div className="md-loading" role="status" aria-live="polite">
        <span className="md-loading__dot" />
        正在加载对战数据…
      </div>
    )
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

  return (
    <div className="md-body">
      <header className="md-hero">
        <div className="md-hero__meta">
          <span className="md-hero__league">{view.league}</span>
          <span className="md-hero__kickoff">{view.kickoff}</span>
          <span className="md-hero__status">{view.statusLabel}</span>
        </div>
        <div className="md-hero__score">
          <span className="md-hero__team">{view.homeName}</span>
          <strong className={view.scoreText === 'VS' ? 'is-vs' : ''}>{view.scoreText}</strong>
          <span className="md-hero__team">{view.awayName}</span>
        </div>
        {view.htftText && <div className="md-hero__htft">{view.htftText}</div>}
      </header>

      <Section title="历史交锋" sub={view.h2h.summary}>
        {view.h2h.items.length === 0 ? (
          <Empty />
        ) : (
          <ul className="md-list">
            {view.h2h.items.map((item, index) => (
              <li key={`${item.date}-${index}`} className="md-list__row">
                <span className="md-list__date">{item.date}</span>
                <span className="md-list__league">{item.league}</span>
                <span className="md-list__teams">
                  {item.home} <b>{item.score}</b> {item.away}
                </span>
                {item.half && <span className="md-list__half">半 {item.half}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="伤停">
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

      <Section title="近期战绩">
        <div className="md-columns">
          <SideBlock group={view.recent.home}>
            {(item) => (
              <li key={`${item.date}-${item.home}-${item.away}`} className="md-form">
                <span className="md-list__date">{item.date}</span>
                <em className={`md-form__tag is-${item.tag || 'none'}`}>{item.tag || '-'}</em>
                <span className="md-list__teams">
                  {item.home} <b>{item.score}</b> {item.away}
                </span>
              </li>
            )}
          </SideBlock>
          <SideBlock group={view.recent.away}>
            {(item) => (
              <li key={`${item.date}-${item.home}-${item.away}`} className="md-form">
                <span className="md-list__date">{item.date}</span>
                <em className={`md-form__tag is-${item.tag || 'none'}`}>{item.tag || '-'}</em>
                <span className="md-list__teams">
                  {item.home} <b>{item.score}</b> {item.away}
                </span>
              </li>
            )}
          </SideBlock>
        </div>
      </Section>

      <Section title="未来赛程">
        <div className="md-columns">
          <SideBlock group={view.upcoming.home}>
            {(item) => (
              <li key={`${item.date}-${item.home}-${item.away}`} className="md-fixture">
                <span className="md-list__date">
                  {item.date} {item.time}
                </span>
                <span className="md-list__teams">
                  {item.home} vs {item.away}
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
                <span className="md-list__teams">
                  {item.home} vs {item.away}
                </span>
                {item.league && <span className="md-list__league">{item.league}</span>}
              </li>
            )}
          </SideBlock>
        </div>
      </Section>

      <Section title={view.table.tournament ? `积分榜 · ${view.table.tournament}` : '积分榜'}>
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
                  <td>{row.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="阵容">
        <div className="md-columns">
          {[view.lineup.home, view.lineup.away].map((team, index) =>
            team ? (
              <div className="md-side" key={`lineup-${index}`}>
                <div className="md-side__title">
                  {team.teamName}
                  <span>
                    {team.formation}
                    {team.confirmed ? '' : ' 预测'}
                  </span>
                </div>
                <ul className="md-lineup">
                  {team.starters.map((player) => (
                    <li key={player.name} className="md-lineup__row">
                      <em>{player.number || '-'}</em>
                      <span>{player.name}</span>
                      {player.position && <i>{player.position}</i>}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="md-side" key={`lineup-${index}`}>
                <p className="md-empty">暂无数据</p>
              </div>
            ),
          )}
        </div>
      </Section>

      <Section title="射手">
        <div className="md-columns">
          <SideBlock group={view.shooters.home}>
            {(person) => (
              <li key={person.name} className="md-shooter">
                <span className="md-injury__name">{person.name}</span>
                <span className="md-shooter__stat">{person.goals} 球</span>
                {person.assists > 0 && <span className="md-shooter__stat">{person.assists} 助</span>}
              </li>
            )}
          </SideBlock>
          <SideBlock group={view.shooters.away}>
            {(person) => (
              <li key={person.name} className="md-shooter">
                <span className="md-injury__name">{person.name}</span>
                <span className="md-shooter__stat">{person.goals} 球</span>
                {person.assists > 0 && <span className="md-shooter__stat">{person.assists} 助</span>}
              </li>
            )}
          </SideBlock>
        </div>
      </Section>
    </div>
  )
}

function Section({
  title,
  sub,
  children,
}: {
  title: string
  sub?: string
  children: ReactNode
}) {
  return (
    <section className="md-section">
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
        {group.teamName}
        <span>{group.items.length > 0 ? `${group.items.length} 条` : '暂无数据'}</span>
      </div>
      {group.items.length > 0 ? <ul className="md-side__list">{group.items.map(children)}</ul> : <p className="md-empty">暂无数据</p>}
    </div>
  )
}
