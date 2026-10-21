import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AnalysisText } from './AnalysisText'
import { useAiPanelPosition } from './useAiPanelPosition'
import { type ParlayAnalysisInput } from './parlayAiAnalysis'
import { type ParlayAiAnalysisState } from './useParlayAiAnalysis'

type ParlayAiAnalysisPanelProps = {
  analysis: ParlayAiAnalysisState | null
  anchor: HTMLElement | null
  onClose: () => void
  onRetry: () => void
}

/** 方案级 AI 分析浮层：逐场判断已选比赛，并评估整个串关的风险。 */
export function ParlayAiAnalysisPanel({
  analysis,
  anchor,
  onClose,
  onRetry,
}: ParlayAiAnalysisPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [copied, setCopied] = useState(false)
  const { position, isMobile } = useAiPanelPosition(anchor)

  useEffect(() => {
    if (!analysis) {
      return
    }
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
  }, [analysis?.content, analysis?.status])

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

  const { input, status, content, error, summary, elapsedMs } = analysis

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
        className={`ai-analysis ai-analysis--parlay${isMobile ? ' is-mobile' : ''}`}
        style={(position ?? undefined) as CSSProperties | undefined}
        role="dialog"
        aria-modal={isMobile}
        aria-label="AI 串关分析"
      >
        <header className="ai-analysis__header">
          <div className="ai-analysis__heading">
            <span className="ai-analysis__eyebrow">AI 串关分析</span>
            <h3>本方案 {input.entries.length} 场过关</h3>
            <p>
              {input.passSummaryText || '未选择过关方式'} · 已选 {input.entries.length} 场 · 逐场判断
            </p>
          </div>
          <button type="button" className="ai-analysis__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="ai-analysis__status" aria-live="polite">
          <span className={`ai-analysis__status-text is-${status}`}>
            {status === 'loading' && (
              <>
                <i className="ai-analysis__spinner" aria-hidden="true" />
                正在整理 {input.entries.length} 场对阵与所选赔率…
              </>
            )}
            {status === 'streaming' && (
              <>
                <i className="ai-analysis__dot" aria-hidden="true" />
                正在逐场分析这个串关…
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
          <span className="ai-analysis__weather" title="分析范围">
            逐场 + 串关风险
          </span>
        </div>

        <div className="ai-analysis__body" ref={bodyRef}>
          {status === 'loading' && <PreparingState input={input} />}

          {status === 'error' && (
            <div className="ai-analysis__error">
              <p>{error || 'AI 分析失败，请稍后重试'}</p>
              <button type="button" onClick={onRetry}>
                重试
              </button>
            </div>
          )}

          {summary && status === 'done' && (
            <div className="ai-analysis__summary ai-analysis__summary--parlay">
              <div className="ai-analysis__summary-main">
                <span>整体风险</span>
                <strong className={riskClass(summary.risk)}>{summary.risk || '见下方'}</strong>
              </div>
              <div className="ai-analysis__summary-meta">
                {summary.confidence && (
                  <span>
                    综合信心{' '}
                    <b className={`is-${confidenceClass(summary.confidence)}`}>
                      {summary.confidence}
                    </b>
                  </span>
                )}
                {summary.verdict && <span className="ai-analysis__summary-verdict">{summary.verdict}</span>}
              </div>
            </div>
          )}

          {status === 'streaming' && !content && (
            <div className="ai-analysis__stream-loading">
              <i className="ai-analysis__spinner" aria-hidden="true" />
              正在生成逐场判断…
            </div>
          )}

          {content && (
            <section className="ai-analysis__result">
              {status === 'done' && <h4 className="ai-analysis__result-title">逐场与串关判断</h4>}
              <AnalysisText text={content} numberedAsHeading />
            </section>
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

function PreparingState({ input }: { input: ParlayAnalysisInput }) {
  return (
    <div className="ai-analysis__preparing">
      <div className="ai-analysis__loading-title">
        <i className="ai-analysis__spinner" aria-hidden="true" />
        正在拆解这 {input.entries.length} 场比赛
      </div>
      <ul className="ai-analysis__legs">
        {input.entries.map((entry, index) => (
          <li key={entry.id} style={{ animationDelay: `${index * 70}ms` }}>
            <div className="ai-analysis__leg-head">
              <strong>
                {entry.order}. {entry.matchNo} {entry.teams}
              </strong>
              <span>{entry.kickoffTime}</span>
            </div>
            <div className="ai-analysis__leg-options">
              {entry.selectedOptions.map((option) => (
                <span key={`${entry.id}-${option.key}`}>
                  {option.label}
                  {option.value ? ` ${option.value}` : ''}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <p>会逐场判断所选选项是否成立，再评估串关的整体风险。</p>
    </div>
  )
}

function riskClass(risk: string) {
  if (risk === '高') {
    return 'is-high'
  }
  if (risk === '中') {
    return 'is-mid'
  }
  return 'is-low'
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
