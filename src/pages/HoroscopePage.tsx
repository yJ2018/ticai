import { useEffect, useMemo, useState } from 'react'
import { CONSTELLATIONS, HOROSCOPE_TYPES, type ConstellationName, type HoroscopeData, type HoroscopeType } from '../domain/constellation'
import { type WeatherData } from '../domain/weather'
import { constellationService } from '../service/constellationService'
import { weatherService } from '../service/weatherService'

type HoroscopeState = {
  loading: boolean
  error: string
  data: HoroscopeData | null
}

type WeatherState = {
  loading: boolean
  error: string
  data: WeatherData | null
}

const initialState: HoroscopeState = {
  loading: false,
  error: '',
  data: null,
}

const initialWeatherState: WeatherState = {
  loading: false,
  error: '',
  data: null,
}

export function HoroscopePage() {
  const [activeConstellation, setActiveConstellation] = useState<ConstellationName>('双子座')
  const [activeType, setActiveType] = useState<HoroscopeType>('today')
  const [reloadSeed, setReloadSeed] = useState(0)
  const [state, setState] = useState<HoroscopeState>(initialState)
  const [weatherState, setWeatherState] = useState<WeatherState>(initialWeatherState)
  const activeConstellationMeta = useMemo(
    () => CONSTELLATIONS.find((item) => item.name === activeConstellation),
    [activeConstellation],
  )
  const activeTypeLabel = useMemo(
    () => HOROSCOPE_TYPES.find((item) => item.key === activeType)?.label ?? '今日',
    [activeType],
  )

  useEffect(() => {
    const controller = new AbortController()

    setState((prev) => ({
      ...prev,
      loading: true,
      error: '',
    }))

    void constellationService
      .getHoroscope(activeConstellation, activeType, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) {
          return
        }
        setState({
          loading: false,
          error: '',
          data,
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return
        }

        setState({
          loading: false,
          error: error instanceof Error ? error.message : '星座运势加载失败，请稍后重试',
          data: null,
        })
      })

    return () => {
      controller.abort()
    }
  }, [activeConstellation, activeType, reloadSeed])

  useEffect(() => {
    const controller = new AbortController()

    setWeatherState((prev) => ({
      ...prev,
      loading: true,
      error: '',
    }))

    void weatherService
      .getWeatherByLocation(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) {
          return
        }
        setWeatherState({
          loading: false,
          error: '',
          data,
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return
        }

        setWeatherState({
          loading: false,
          error: error instanceof Error ? error.message : '天气加载失败，请稍后重试',
          data: null,
        })
      })

    return () => {
      controller.abort()
    }
  }, [reloadSeed])

  return (
    <section className="horoscope-page">
      <header className="horoscope-page__header">
        <div>
          <p className="horoscope-page__eyebrow">星座运势</p>
          <h2>12 星座每日运势查询</h2>
        </div>
        <p className="horoscope-page__desc">支持查看今日、明日、本周、本月和本年的星座运势，数据经服务端 BFF 转发聚合数据接口。</p>
      </header>

      <div className="horoscope-page__toolbar">
        <div className="horoscope-page__type-tabs" role="tablist" aria-label="运势类型切换">
          {HOROSCOPE_TYPES.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={activeType === item.key}
              className={activeType === item.key ? 'is-active' : ''}
              onClick={() => setActiveType(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="horoscope-page__refresh"
          onClick={() => setReloadSeed((prev) => prev + 1)}
        >
          刷新全部
        </button>
      </div>

      <div className="horoscope-page__content">
        <section className="weather-panel">
          <div className="weather-panel__header">
            <div>
              <p className="weather-panel__eyebrow">当前天气</p>
              <h3>基于服务端 IP 定位</h3>
            </div>
          </div>

          {weatherState.loading && <div className="weather-panel__status">正在获取定位并加载天气...</div>}

          {!weatherState.loading && weatherState.error && (
            <div className="weather-panel__status weather-panel__status--error">
              <span>{weatherState.error}</span>
              <button type="button" onClick={() => setReloadSeed((prev) => prev + 1)}>
                重试
              </button>
            </div>
          )}

          {!weatherState.loading && !weatherState.error && weatherState.data && (
            <>
              <div className="weather-panel__hero">
                <div>
                  <p className="weather-panel__city">{weatherState.data.city}</p>
                  <h4>{weatherState.data.weather}</h4>
                  <span>
                    {weatherState.data.date} {weatherState.data.week}
                  </span>
                </div>
                <div className="weather-panel__temp">
                  <strong>{weatherState.data.currentTemp}</strong>
                  <span>{weatherState.data.temperatureRange}</span>
                </div>
              </div>

              <div className="weather-metrics">
                <article className="weather-metrics__card">
                  <span>风向风力</span>
                  <strong>
                    {weatherState.data.windDirection} {weatherState.data.windStrength}
                  </strong>
                </article>
                <article className="weather-metrics__card">
                  <span>湿度</span>
                  <strong>{weatherState.data.humidity}</strong>
                </article>
                <article className="weather-metrics__card">
                  <span>更新时间</span>
                  <strong>{weatherState.data.updateTime}</strong>
                </article>
                <article className="weather-metrics__card">
                  <span>紫外线</span>
                  <strong>{weatherState.data.uvIndex}</strong>
                </article>
              </div>

              <div className="weather-indexes">
                <article className="weather-indexes__item">
                  <span>穿衣指数</span>
                  <strong>{weatherState.data.dressingIndex}</strong>
                </article>
                <article className="weather-indexes__item">
                  <span>洗车指数</span>
                  <strong>{weatherState.data.washingIndex}</strong>
                </article>
                <article className="weather-indexes__item">
                  <span>旅游指数</span>
                  <strong>{weatherState.data.travelIndex}</strong>
                </article>
                <article className="weather-indexes__item">
                  <span>运动指数</span>
                  <strong>{weatherState.data.exerciseIndex}</strong>
                </article>
              </div>

              <div className="weather-panel__advice">
                <span>穿衣建议</span>
                <p>{weatherState.data.dressingAdvice}</p>
              </div>

              <div className="weather-forecast">
                {weatherState.data.future.map((item) => (
                  <article key={`${item.date}-${item.week}`} className="weather-forecast__item">
                    <span>{item.week}</span>
                    <strong>{item.date}</strong>
                    <b>{item.weather}</b>
                    <em>{item.temperature}</em>
                    <small>{item.wind}</small>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>

        <div className="horoscope-page__constellations" aria-label="星座切换">
          {CONSTELLATIONS.map((item) => (
            <button
              key={item.name}
              type="button"
              className={activeConstellation === item.name ? 'is-active' : ''}
              onClick={() => setActiveConstellation(item.name)}
            >
              <strong>{item.name}</strong>
              <span>{item.dateRange}</span>
            </button>
          ))}
        </div>

        {state.loading && <div className="horoscope-page__status">正在加载 {activeConstellation} 的{activeTypeLabel}运势...</div>}

        {!state.loading && state.error && (
          <div className="horoscope-page__status horoscope-page__status--error">
            <span>{state.error}</span>
            <button type="button" onClick={() => setReloadSeed((prev) => prev + 1)}>
              重新加载
            </button>
          </div>
        )}

        {!state.loading && !state.error && state.data && (
          <>
            <section className="horoscope-hero">
              <div className="horoscope-hero__main">
                <div>
                  <p className="horoscope-hero__eyebrow">{state.data.datetime}</p>
                  <h3>{state.data.name}</h3>
                  <span>
                    星座区间 {state.data.dateRange} · {activeTypeLabel}运势
                  </span>
                </div>
                <div className="horoscope-hero__score">
                  <span>综合指数</span>
                  <strong>{state.data.all}</strong>
                </div>
              </div>
              <p className="horoscope-hero__summary">{state.data.summary}</p>
            </section>

            <section className="horoscope-metrics">
              <article className="horoscope-metrics__card">
                <span>爱情运势</span>
                <strong>{state.data.love}</strong>
              </article>
              <article className="horoscope-metrics__card">
                <span>事业运势</span>
                <strong>{state.data.work}</strong>
              </article>
              <article className="horoscope-metrics__card">
                <span>财运指数</span>
                <strong>{state.data.money}</strong>
              </article>
              <article className="horoscope-metrics__card">
                <span>健康指数</span>
                <strong>{state.data.health}</strong>
              </article>
            </section>

            <section className="horoscope-facts">
              <article className="horoscope-facts__item">
                <span>幸运颜色</span>
                <strong>{state.data.color}</strong>
              </article>
              <article className="horoscope-facts__item">
                <span>幸运数字</span>
                <strong>{state.data.number}</strong>
              </article>
              <article className="horoscope-facts__item">
                <span>速配星座</span>
                <strong>{state.data.qFriend}</strong>
              </article>
              <article className="horoscope-facts__item">
                <span>当前选择</span>
                <strong>{activeConstellationMeta?.name ?? state.data.name}</strong>
              </article>
            </section>

            <section className="horoscope-panel">
              <div className="horoscope-panel__header">
                <div>
                  <p className="horoscope-panel__eyebrow">运势解读</p>
                  <h3>{state.data.name}{activeTypeLabel}建议</h3>
                </div>
              </div>
              <p className="horoscope-panel__text">{state.data.summary}</p>
            </section>
          </>
        )}
      </div>
    </section>
  )
}
