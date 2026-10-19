import { type MatchCard, type MatchCardOptionGroup, type MatchPoolType } from '../../service/matchService'
import { formatKickoffTime } from './betSlipMath'

type MatchPoolListProps = {
  panelAnimClass: string
  loading: boolean
  error: string
  items: MatchCard[]
  activePool: MatchPoolType
  selectedOptionKeys: Record<number, string[]>
  expandedMixedIds: number[]
  onToggleOption: (matchId: number, optionKey: string) => void
  onToggleMixed: (matchId: number) => void
  onAnalyze: (item: MatchCard, anchor: HTMLButtonElement) => void
}

/** 赛事列表：普通玩法卡片 + 混合过关（可展开更多玩法） */
export function MatchPoolList({
  panelAnimClass,
  loading,
  error,
  items,
  activePool,
  selectedOptionKeys,
  expandedMixedIds,
  onToggleOption,
  onToggleMixed,
  onAnalyze,
}: MatchPoolListProps) {
  function renderOptionGroups(item: MatchCard, wrapGroups = false, groups?: MatchCardOptionGroup[]) {
    const groupList = groups ?? item.optionGroups ?? []

    return groupList.map((group) => {
      const rowContent = (
        <div key={group.key} className={`pool-card__row ${group.rowLabel ? 'has-row-label' : ''}`}>
          {group.rowLabel && <div className="pool-card__row-label">{group.rowLabel}</div>}
          <div
            className="pool-card__odds"
            style={{ gridTemplateColumns: `repeat(${group.columns}, minmax(0, 1fr))` }}
          >
            {group.options.map((option) => {
              const active = (selectedOptionKeys[item.id] ?? []).includes(option.key)
              return (
                <button
                  key={option.key}
                  type="button"
                  disabled={option.value === '--'}
                  className={`pool-card__odd-item ${active ? 'is-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => onToggleOption(item.id, option.key)}
                >
                  <i>{option.label}</i>
                  <b>{option.value}</b>
                </button>
              )
            })}
          </div>
        </div>
      )

      if (wrapGroups) {
        return (
          <div key={group.key} className="pool-card__group-wrap">
            {rowContent}
          </div>
        )
      }

      return rowContent
    })
  }

  function renderMatchHead(item: MatchCard) {
    return (
      <div className="pool-card__head">
        <div className="pool-card__issue">
          <strong>{item.matchNo || '周?000'}</strong>
          <span>{formatKickoffTime(item.time)}</span>
        </div>
        <div className="pool-card__main">
          <div className="pool-card__league">{item.subtitle}</div>
          <div className="pool-card__teams">
            <span>{item.homeTeam || '主队'}</span>
            <em>VS</em>
            <span>{item.awayTeam || '客队'}</span>
          </div>
        </div>
        <button
          type="button"
          className="pool-card__ai-btn"
          aria-label={`AI 分析：${item.homeTeam || '主队'} 对 ${item.awayTeam || '客队'}`}
          title="AI 分析这场比赛"
          onClick={(event) => {
            event.stopPropagation()
            onAnalyze(item, event.currentTarget)
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path
              d="M12 2.6l1.9 5.5 5.5 1.9-5.5 1.9L12 17.4l-1.9-5.5L4.6 10l5.5-1.9L12 2.6z"
              fill="currentColor"
            />
            <path
              d="M18.6 15.4l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z"
              fill="currentColor"
              opacity="0.75"
            />
          </svg>
          <span className="pool-card__ai-btn-label">AI 分析</span>
          <span className="pool-card__ai-btn-short">AI</span>
        </button>
      </div>
    )
  }

  return (
    <div className={`home-page__result-panel ${panelAnimClass}`}>
      <ul className="home-page__list">
        {loading && <li>正在加载比赛数据...</li>}
        {!loading && error && <li>{error}</li>}
        {!loading &&
          !error &&
          items.map((item) => {
            const picked = (selectedOptionKeys[item.id]?.length ?? 0) > 0

            if (activePool === 'mixed') {
              const expanded = expandedMixedIds.includes(item.id)
              return (
                <li key={item.id} className={`${picked ? 'is-picked ' : ''}is-option-layout`}>
                  <div className="pool-card pool-card--mixed">
                    {renderMatchHead(item)}
                    <div className="pool-card__odds-wrap">
                      {renderOptionGroups(item)}
                      <div className="mixed-card__toggle-row">
                        <button
                          type="button"
                          className="mixed-card__toggle"
                          onClick={() => onToggleMixed(item.id)}
                        >
                          {expanded ? '收起' : '展开更多玩法'}
                        </button>
                      </div>
                    </div>
                    {expanded && (
                      <div className="mixed-card__sections">
                        {(item.mixedSections ?? []).map((section) => (
                          <section
                            key={section.key}
                            className={`mixed-card__section mixed-card__section--${section.poolType}`}
                          >
                            <h4>{section.title}</h4>
                            {renderOptionGroups(item, section.poolType === 'crs', section.groups)}
                          </section>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              )
            }

            return (
              <li key={item.id} className={`${picked ? 'is-picked ' : ''}is-option-layout`}>
                <div className={`pool-card pool-card--${activePool}`}>
                  {renderMatchHead(item)}
                  <div className="pool-card__odds-wrap">
                    {renderOptionGroups(item, activePool === 'crs')}
                  </div>
                </div>
              </li>
            )
          })}
      </ul>
    </div>
  )
}
