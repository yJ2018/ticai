import { createPortal } from 'react-dom'

type SnapshotOverlayProps = {
  url: string
  viewerOpen: boolean
  onOpenViewer: () => void
  onCloseViewer: () => void
  onDownload: () => void
  onRemove: () => void
}

/** 方案截图：右下角悬浮缩略图 + 大图预览层 */
export function SnapshotOverlay({
  url,
  viewerOpen,
  onOpenViewer,
  onCloseViewer,
  onDownload,
  onRemove,
}: SnapshotOverlayProps) {
  if (!url || typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <>
      <div className="plan-modal__snapshot-float">
        <button type="button" className="plan-modal__snapshot-thumb" onClick={onOpenViewer}>
          <img src={url} alt="当前屏幕快照" />
        </button>
        <div className="plan-modal__snapshot-actions">
          <button type="button" onClick={onDownload}>
            保存
          </button>
          <button type="button" onClick={onRemove}>
            移除
          </button>
        </div>
      </div>
      {viewerOpen && (
        <div className="plan-modal__snapshot-viewer" onClick={onCloseViewer}>
          <div className="plan-modal__snapshot-dialog" onClick={(event) => event.stopPropagation()}>
            <img src={url} alt="方案快照大图" />
            <div className="plan-modal__snapshot-toolbar">
              <button type="button" onClick={onDownload}>
                保存到本地
              </button>
              <button type="button" onClick={onRemove}>
                移除
              </button>
              <button type="button" onClick={onCloseViewer}>
                关闭预览
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  )
}
