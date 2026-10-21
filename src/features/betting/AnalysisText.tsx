import { type ReactNode } from 'react'

type AnalysisTextProps = {
  text: string
  /** 串关分析里「1. 场次」是场次标题；单场分析的数字列表则是分析维度，保持正文。 */
  numberedAsHeading?: boolean
}

/** 把模型返回的纯文本按小节标题 / 重点行渲染成轻量富文本。 */
export function AnalysisText({ text, numberedAsHeading = false }: AnalysisTextProps) {
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
    if (numberedAsHeading && /^\d+\.\s/.test(trimmed)) {
      nodes.push(
        <h5 key={`match-${index}`} className="ai-analysis__match-title">
          {trimmed}
        </h5>,
      )
      return
    }
    if (/^(推荐选项|比分参考|信心等级|理由|整体风险|综合信心|一句话总结)[：:]/.test(trimmed)) {
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
