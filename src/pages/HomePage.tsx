import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type TouchEvent } from 'react'
import html2canvas from 'html2canvas'
import { useMatchStore } from '../store/matchStore'
import { type MatchCard, type MatchPoolType } from '../service/matchService'
import { BetSlipFooter } from '../features/betting/BetSlipFooter'
import { MatchPoolList } from '../features/betting/MatchPoolList'
import { PlanModal } from '../features/betting/PlanModal'
import { SnapshotOverlay } from '../features/betting/SnapshotOverlay'
import { AiAnalysisPanel } from '../features/betting/AiAnalysisPanel'
import { useMatchAiAnalysis } from '../features/betting/useMatchAiAnalysis'
import { useBetSlip } from '../features/betting/useBetSlip'
import { PLAN_MODAL_ANIMATION_MS, formatMoney, getSportteryTaxInfo } from '../features/betting/betSlipMath'

const poolTabs: Array<{ key: MatchPoolType; label: string }> = [
  { key: 'had', label: '胜平负' },
  { key: 'crs', label: '比分' },
  { key: 'ttg', label: '进球数' },
  { key: 'hafu', label: '半全场' },
  { key: 'mixed', label: '混合过关' },
]

export function HomePage() {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const planModalTimerRef = useRef<number | null>(null)
  const planModalLayerRef = useRef<HTMLDivElement | null>(null)

  const [panelAnimClass, setPanelAnimClass] = useState('')
  const [panelAnimTick, setPanelAnimTick] = useState(0)
  const [isPassPanelOpen, setIsPassPanelOpen] = useState(false)
  const [isMultiplePanelOpen, setIsMultiplePanelOpen] = useState(false)
  const [isPlanModalMounted, setIsPlanModalMounted] = useState(false)
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false)
  const [snapshotUrl, setSnapshotUrl] = useState('')
  const [isSnapshotViewerOpen, setIsSnapshotViewerOpen] = useState(false)
  const [isCapturingSnapshot, setIsCapturingSnapshot] = useState(false)
  const [multipleDraft, setMultipleDraft] = useState('')
  const [toastText, setToastText] = useState('')

  const activePool = useMatchStore((state) => state.activePool)
  const poolCache = useMatchStore((state) => state.poolCache)
  const extraCardsByPool = useMatchStore((state) => state.extraCardsByPool)
  const setActivePool = useMatchStore((state) => state.setActivePool)
  const loadMatches = useMatchStore((state) => state.loadMatches)

  const activeCache = poolCache[activePool]
  const items = useMemo(
    () => [...extraCardsByPool[activePool], ...activeCache.cards],
    [extraCardsByPool, activePool, activeCache.cards],
  )

  const betSlip = useBetSlip(items, activePool)
  const aiAnalysis = useMatchAiAnalysis(activePool)

  useEffect(() => {
    loadMatches()
  }, [loadMatches])

  useEffect(() => {
    if (!toastText) {
      return
    }
    const timer = window.setTimeout(() => setToastText(''), 1500)
    return () => window.clearTimeout(timer)
  }, [toastText])

  useEffect(
    () => () => {
      if (planModalTimerRef.current) {
        window.clearTimeout(planModalTimerRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    if (!isPlanModalMounted || typeof document === 'undefined') {
      return
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isPlanModalMounted])

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    const touch = event.touches[0]
    touchStartRef.current = { x: touch.clientX, y: touch.clientY }
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    if (!touchStartRef.current) {
      return
    }

    const touch = event.changedTouches[0]
    const deltaX = touch.clientX - touchStartRef.current.x
    const deltaY = touch.clientY - touchStartRef.current.y
    touchStartRef.current = null

    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) {
      return
    }

    const currentIndex = poolTabs.findIndex((tab) => tab.key === activePool)
    if (currentIndex < 0) {
      return
    }

    if (deltaX < 0 && currentIndex < poolTabs.length - 1) {
      switchPool(poolTabs[currentIndex + 1].key)
      return
    }

    if (deltaX > 0 && currentIndex > 0) {
      switchPool(poolTabs[currentIndex - 1].key)
    }
  }

  function switchPool(nextPool: MatchPoolType) {
    if (nextPool === activePool) {
      return
    }

    const currentIndex = poolTabs.findIndex((tab) => tab.key === activePool)
    const nextIndex = poolTabs.findIndex((tab) => tab.key === nextPool)
    const direction = nextIndex > currentIndex ? 'slide-from-right' : 'slide-from-left'

    setPanelAnimClass(direction)
    setPanelAnimTick((prev) => prev + 1)
    setActivePool(nextPool)
    setIsPassPanelOpen(false)
    setIsMultiplePanelOpen(false)
    aiAnalysis.close()
    closePlanModal()
  }

  function togglePassPanel() {
    setIsMultiplePanelOpen(false)
    setIsPassPanelOpen((prev) => !prev)
  }

  function closeAllPanels() {
    setIsPassPanelOpen(false)
    setIsMultiplePanelOpen(false)
  }

  function handlePanelMaskPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
  }

  function handlePanelMaskClick(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    closeAllPanels()
  }

  function shouldKeepFooterClick(eventTarget: EventTarget | null) {
    if (!(eventTarget instanceof Element)) {
      return false
    }
    return Boolean(
      eventTarget.closest(
        '.bet-pass__panel, .bet-multiple__panel, .bet-pass__trigger, .bet-multiple__trigger, .bet-plan__trigger',
      ),
    )
  }

  function handleFooterPointerDownCapture(event: PointerEvent<HTMLElement>) {
    if (!isPassPanelOpen && !isMultiplePanelOpen) {
      return
    }
    if (shouldKeepFooterClick(event.target)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  function handleFooterClickCapture(event: MouseEvent<HTMLElement>) {
    if (!isPassPanelOpen && !isMultiplePanelOpen) {
      return
    }
    if (shouldKeepFooterClick(event.target)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    closeAllPanels()
  }

  function clearPlan() {
    betSlip.reset()
    setMultipleDraft('')
    closePlanModal()
    closeAllPanels()
    aiAnalysis.close()
  }

  function closePlanModal() {
    if (planModalTimerRef.current) {
      window.clearTimeout(planModalTimerRef.current)
      planModalTimerRef.current = null
    }
    setIsPlanModalOpen(false)
    planModalTimerRef.current = window.setTimeout(() => {
      setIsPlanModalMounted(false)
      planModalTimerRef.current = null
    }, PLAN_MODAL_ANIMATION_MS)
  }

  function openPlanModal() {
    if (betSlip.selectedCount === 0) {
      setToastText('请先选择比赛')
      return
    }
    closeAllPanels()
    aiAnalysis.close()
    if (planModalTimerRef.current) {
      window.clearTimeout(planModalTimerRef.current)
      planModalTimerRef.current = null
    }
    setIsPlanModalMounted(true)
    window.requestAnimationFrame(() => {
      setIsPlanModalOpen(true)
    })
  }

  function openAiAnalysis(item: MatchCard, anchor: HTMLButtonElement) {
    if (aiAnalysis.analysis?.key === `${activePool}:${item.id}`) {
      aiAnalysis.close()
      return
    }
    closeAllPanels()
    aiAnalysis.open(item, anchor)
  }

  function openMultiplePanel() {
    setIsPassPanelOpen(false)
    setMultipleDraft('')
    setIsMultiplePanelOpen(true)
  }

  async function captureSnapshot() {
    if (isCapturingSnapshot || typeof window === 'undefined') {
      return
    }
    const captureTarget = planModalLayerRef.current
    if (!captureTarget) {
      setToastText('未找到可截图区域')
      return
    }
    setIsCapturingSnapshot(true)
    try {
      const canvas = await html2canvas(captureTarget, {
        useCORS: true,
        scale: Math.min(window.devicePixelRatio || 1, 2),
        backgroundColor: null,
      })
      const dataUrl = canvas.toDataURL('image/png')
      setSnapshotUrl(dataUrl)
      setIsSnapshotViewerOpen(false)
      setToastText('已生成屏幕快照')
    } catch {
      setToastText('截图失败，请重试')
    } finally {
      setIsCapturingSnapshot(false)
    }
  }

  function openSnapshotViewer() {
    if (!snapshotUrl) {
      return
    }
    setIsSnapshotViewerOpen(true)
  }

  function closeSnapshotViewer() {
    setIsSnapshotViewerOpen(false)
  }

  function downloadSnapshot() {
    if (!snapshotUrl || typeof document === 'undefined') {
      return
    }
    const link = document.createElement('a')
    link.href = snapshotUrl
    link.download = `方案快照-${Date.now()}.png`
    link.click()
  }

  function removeSnapshot() {
    setSnapshotUrl('')
    setIsSnapshotViewerOpen(false)
  }

  function appendMultipleDigit(digit: string) {
    const base = multipleDraft === '0' ? '' : multipleDraft
    const nextText = `${base}${digit}`.slice(0, 3)
    const nextValue = Number(nextText)
    if (nextValue > 50) {
      setToastText('最大50')
      setMultipleDraft('50')
      return
    }
    setMultipleDraft(nextText)
  }

  function removeMultipleDigit() {
    setMultipleDraft((prev) => prev.slice(0, -1))
  }

  function confirmMultiple() {
    if (!multipleDraft) {
      setIsMultiplePanelOpen(false)
      return
    }
    const numericValue = Number(multipleDraft)
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      betSlip.setMultiple(1)
      setIsMultiplePanelOpen(false)
      return
    }
    betSlip.setMultiple(Math.min(50, Math.max(1, numericValue)))
    setIsMultiplePanelOpen(false)
  }

  function showMaxBonusTax() {
    if (betSlip.maxBonus <= 0) {
      setToastText('当前暂无可计算税额的奖金')
      return
    }
    const taxInfo = getSportteryTaxInfo(betSlip.maxBonus)
    if (taxInfo.taxAmount <= 0) {
      setToastText('税额 0 元，单次中奖收入不超过10000元免税')
      return
    }
    setToastText(`税额 ${formatMoney(taxInfo.taxAmount)} 元，税后约 ${formatMoney(taxInfo.afterTaxAmount)} 元`)
  }

  return (
    <section className="home-page">
      <header className="home-page__nav">
        <nav className="home-page__pool-nav">
          {poolTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={tab.key === activePool ? 'is-active' : ''}
              onClick={() => switchPool(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="home-page__body">
        <div className="home-page__content" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
          <MatchPoolList
            key={`${activePool}-${panelAnimTick}`}
            panelAnimClass={panelAnimClass}
            loading={activeCache.loading}
            error={activeCache.error}
            items={items}
            activePool={activePool}
            selectedOptionKeys={betSlip.selectedOptionKeys}
            expandedMixedIds={betSlip.expandedMixedIds}
            onToggleOption={betSlip.toggleOption}
            onToggleMixed={betSlip.toggleMixedExpand}
            onAnalyze={openAiAnalysis}
          />
        </div>
      </div>

      <AiAnalysisPanel
        analysis={aiAnalysis.analysis}
        anchor={aiAnalysis.anchor}
        onClose={aiAnalysis.close}
        onRetry={aiAnalysis.retry}
      />

      {(isPassPanelOpen || isMultiplePanelOpen) && (
        <div
          className="home-page__panel-mask"
          onPointerDown={handlePanelMaskPointerDown}
          onClick={handlePanelMaskClick}
        />
      )}

      <BetSlipFooter
        selectedCount={betSlip.selectedCount}
        passTypeOptions={betSlip.passTypeOptions}
        selectedPassTypes={betSlip.selectedPassTypes}
        onTogglePassType={betSlip.togglePassType}
        isPassPanelOpen={isPassPanelOpen}
        onTogglePassPanel={togglePassPanel}
        isMultiplePanelOpen={isMultiplePanelOpen}
        onOpenMultiplePanel={openMultiplePanel}
        multiple={betSlip.multiple}
        multipleDraft={multipleDraft}
        onAppendMultipleDigit={appendMultipleDigit}
        onRemoveMultipleDigit={removeMultipleDigit}
        onConfirmMultiple={confirmMultiple}
        betAmount={betSlip.betAmount}
        maxBonus={betSlip.maxBonus}
        onShowMaxBonusTax={showMaxBonusTax}
        onClear={clearPlan}
        onOpenPlan={openPlanModal}
        onPointerDownCapture={handleFooterPointerDownCapture}
        onClickCapture={handleFooterClickCapture}
      />

      <PlanModal
        mounted={isPlanModalMounted}
        open={isPlanModalOpen}
        passSummaryText={betSlip.passSummaryText}
        entries={betSlip.planEntries}
        isCapturing={isCapturingSnapshot}
        onCapture={captureSnapshot}
        onClose={closePlanModal}
        layerRef={planModalLayerRef}
      />

      <SnapshotOverlay
        url={snapshotUrl}
        viewerOpen={isSnapshotViewerOpen}
        onOpenViewer={openSnapshotViewer}
        onCloseViewer={closeSnapshotViewer}
        onDownload={downloadSnapshot}
        onRemove={removeSnapshot}
      />

      {toastText && <div className="home-page__toast">{toastText}</div>}
    </section>
  )
}
