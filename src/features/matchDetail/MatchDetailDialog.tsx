import { useEffect } from 'react'
import { createPortal } from 'react-dom'

import { type MatchCard } from '../../service/matchService'
import { MatchDetailContent } from './MatchDetailContent'
import { buildDetailView } from './matchDetailView'
import { useMatchDetail } from './useMatchDetail'
import './matchDetail.scss'

type MatchDetailDialogProps = {
  match: MatchCard | null
  onClose: () => void
}

/**
 * PC 端：弹框展示。
 *
 * 用 portal 挂到 body，避免被列表的 transform/动画容器影响 fixed 定位。
 * 关闭方式：右上角 ×、遮罩点击、Esc。
 */
export function MatchDetailDialog({ match, onClose }: MatchDetailDialogProps) {
  const { detail, loading, error } = useMatchDetail(match?.id ?? null)

  useEffect(() => {
    if (!match) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [match, onClose])

  if (!match) {
    return null
  }

  const view = buildDetailView(detail, {
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    league: match.subtitle,
    time: match.time,
  })

  return createPortal(
    <div
      className="md-modal"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        className="md-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${match.homeTeam || '主队'} 对 ${match.awayTeam || '客队'} 的对战数据`}
      >
        <header className="md-dialog__head">
          <div>
            <h2>对战数据</h2>
            <p>
              {match.matchNo ? `${match.matchNo} · ` : ''}
              {match.subtitle || '未知赛事'}
            </p>
          </div>
          <button type="button" className="md-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="md-dialog__body">
          <MatchDetailContent
            view={view}
            loading={loading}
            error={error}
            fallback={{ homeTeam: match.homeTeam, awayTeam: match.awayTeam, league: match.subtitle }}
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}
