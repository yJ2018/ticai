import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { formatKickoffTime } from './betSlipMath'
import { POOL_LABELS } from './aiAnalysis'
import { type AiAnalysisState } from './useMatchAiAnalysis'

type AiAnalysisPanelProps = {
  analysis: AiAnalysisState | null
  anchor: HTMLElement | null
  onClose: () => void
  onRetry: () => void
}

type PanelPosition = {
  left: number
  top: number
  maxHeight: number
}

const PANEL_WIDTH = 430
const MOBILE_BREAKPOINT = 720

function usePanelPosition(anchor: HTMLElement | null) {
  const [position, setPosition] = useState<PanelPosition | null>(null)
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT,
  )

  useLayoutEffect(() => {
    if (!anchor) {
      setPosition(null)
      return
    }

    const target = anchor

    function update() {
      const mobile = window.innerWidth <= MOBILE_BREAKPOINT
      setIsMobile(mobile)
      if (mobile) {
        setPosition(null)
        return
      }

      const rect = target.getBoundingClientRect()
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 24)

      let left = rect.left - width - 12
      if (left < 12) {
        left = rect.right + 12
      }
      if (left + width > window.innerWidth - 12) {
        left = Math.max(12, (window.innerWidth - width) / 2)
      }

      const estimatedHeight = Math.min(620, window.innerHeight - 24)
      const top = Math.max(
        12,
        Math.min(rect.top - 16, window.innerHeight - estimatedHeight - 12),
      )

      // 面板可能比预估更高，用实际 top 反推可用高度，避免底部超出视口
      setPosition({
        left,
        top,
        maxHeight: Math.max(320, window.innerHeight - top - 12),
      })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor])

  return { position, isMobile }
}

export function AiAnalysisPanel({ analysis, anchor, onClose, onRetry }: AiAnalysisPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [showProcess, setShowProcess] = useState(true)
  const [copied, setCopied] = useState(false)
  const { position, isMobile } = usePanelPosition(anchor)

  useEffect(() => {
    if (!analysis) {
      return
    }
    setShowProcess(true)
    setCopied(false)
  }, [analysis?.key])

  useEffect(() => {
    if (analysis?.status !== 'streaming') {
      return
    }
    const element = bodyRef.current
    if (!element) {
      return
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    if (distance < 140) {
      element.scrollTop = element.scrollHeight
    }
  }, [analysis?.content, analysis?.reasoning, analysis?.status])

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null
      if (!target) {
        return
      }
      if (panelRef.current?.contains(target) || anchor?.contains(target)) {
        return
      }
      onClose()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [anchor, onClose])

  useEffect(() => {
    if (analysis?.status === 'done' && bodyRef.current) {
      // 分析结束后回到顶部，先展示推荐摘要，再让用户向下阅读
      bodyRef.current.scrollTop = 0
    }
  }, [analysis?.status])

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  if (!analysis || !anchor) {
    return null
  }

  const { match, status, content, error, summary, weatherLabel, elapsedMs } = analysis
  const predictionIndex = content.indexOf('【预测】')
  const hasPrediction = predictionIndex >= 0
  const processText = (hasPrediction ? content.slice(0, predictionIndex) : content)
    .replace(/【分析】/g, '')
    .trim()
  const resultText = hasPrediction ? content.slice(predictionIndex + 4).trim() : ''

  async function copyResult() {
    if (!content) {
      return
    }
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return createPortal(
    <>
      {isMobile && <div className="ai-analysis__mask" onClick={onClose} />}
      <aside
        ref={panelRef}
        className={`ai-analysis${isMobile ? ' is-mobile' : ''}`}
        style={(position ?? undefined) as CSSProperties | undefined}
        role="dialog"
        aria-modal={isMobile}
        aria-label="AI 赛前分析"
      >
        <header className="ai-analysis__header">
          <div className="ai-analysis__heading">
            <span className="ai-analysis__eyebrow">AI 赛前分析</span>
            <h3>
              {match.homeTeam ?? '主队'} <em>vs</em> {match.awayTeam ?? '客队'}
            </h3>
            <p>
              {match.matchNo ? `${match.matchNo} · ` : ''}
              {match.subtitle || '未知赛事'} · {formatKickoffTime(match.time)} ·{' '}
              {POOL_LABELS[analysis.pool]}
            </p>
          </div>
          <button type="button" className="ai-analysis__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="ai-analysis__status">
          <span className={`ai-analysis__status-text is-${status}`}>
            {status === 'loading' && (
              <>
                <i className="ai-analysis__spinner" aria-hidden="true" />
                正在获取比赛地天气与分析素材…
              </>
            )}
            {status === 'streaming' && (
              <>
                <i className="ai-analysis__dot" aria-hidden="true" />
                正在分析比赛…
              </>
            )}
            {status === 'done' && (
              <>
                <i className="ai-analysis__dot is-done" aria-hidden="true" />
                分析完成
                {elapsedMs ? ` · ${(elapsedMs / 1000).toFixed(1)}s` : ''}
              </>
            )}
            {status === 'error' && (
              <>
                <i className="ai-analysis__dot is-error" aria-hidden="true" />
                分析失败
              </>
            )}
          </span>
          <span
            className="ai-analysis__weather"
            title="比赛地天气（Open-Meteo 预报）"
          >
            {weatherLabel || '比赛地天气获取中'}
          </span>
        </div>

        <div className="ai-analysis__body" ref={bodyRef}>
          {status === 'loading' && <LoadingState />}

          {status === 'error' && (
            <div className="ai-analysis__error">
              <p>{error || 'AI 分析失败，请稍后重试'}</p>
              <button type="button" onClick={onRetry}>
                重试
              </button>
            </div>
          )}

          {summary && status === 'done' && (
            <div className="ai-analysis__summary">
              <div className="ai-analysis__summary-main">
                <span>推荐</span>
                <strong>{summary.recommendation || '见下方结论'}</strong>
              </div>
              <div className="ai-analysis__summary-meta">
                {summary.confidence && (
                  <span>
                    信心 <b className={`is-${confidenceClass(summary.confidence)}`}>{summary.confidence}</b>
                  </span>
                )}
                {summary.score && <span>比分 {summary.score}</span>}
              </div>
            </div>
          )}

          {(processText || resultText) && (
            <>
              {processText && (
                <section className="ai-analysis__process">
                  <button
                    type="button"
                    className="ai-analysis__process-toggle"
                    onClick={() => setShowProcess((value) => !value)}
                    aria-expanded={showProcess}
                  >
                    <span>分析过程</span>
                    <em>{showProcess ? '收起' : '展开'}</em>
                  </button>
                  {showProcess && (
                    <div className="ai-analysis__process-body">
                      <AnalysisText text={processText} />
                    </div>
                  )}
                </section>
              )}

              {resultText && (
                <section className="ai-analysis__result">
                  <h4 className="ai-analysis__result-title">预测结果</h4>
                  <AnalysisText text={resultText} />
                </section>
              )}
            </>
          )}
        </div>

        <footer className="ai-analysis__footer">
          <span>AI 生成，仅供参考，不构成投注建议</span>
          <div className="ai-analysis__actions">
            {content && (
              <button type="button" onClick={copyResult}>
                {copied ? '已复制' : '复制'}
              </button>
            )}
            {status === 'done' && (
              <button type="button" onClick={onRetry}>
                重新分析
              </button>
            )}
          </div>
        </footer>
      </aside>
    </>,
    document.body,
  )
}

function confidenceClass(confidence: string) {
  if (confidence === '高') {
    return 'high'
  }
  if (confidence === '中') {
    return 'mid'
  }
  return 'low'
}

function LoadingState() {
  const dimensions = ['状态与战术风格', '阵容与伤停', '主客场与赛程', '天气影响', '赔率倾向']

  return (
    <div className="ai-analysis__loading">
      <div className="ai-analysis__loading-title">
        <i className="ai-analysis__spinner" aria-hidden="true" />
        正在阅读比赛信息
      </div>
      <ul>
        {dimensions.map((item, index) => (
          <li key={item} style={{ animationDelay: `${index * 120}ms` }}>
            <span />
            {item}
          </li>
        ))}
      </ul>
      <p>AI 会先梳理这些维度，再给出预测结论。</p>
    </div>
  )
}

function AnalysisText({ text }: { text: string }) {
  const nodes: ReactNode[] = []

  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }
    if (/^【.+】$/.test(trimmed)) {
      nodes.push(
        <h4 key={`h-${index}`} className="ai-analysis__section-title">
          {trimmed.replace(/[【】]/g, '')}
        </h4>,
      )
      return
    }
    if (/^(推荐选项|比分参考|信心等级|理由)[：:]/.test(trimmed)) {
      nodes.push(
        <p key={`key-${index}`} className="ai-analysis__key-line">
          {trimmed}
        </p>,
      )
      return
    }
    nodes.push(<p key={`p-${index}`}>{trimmed}</p>)
  })

  return <div className="ai-analysis__text">{nodes}</div>
}
