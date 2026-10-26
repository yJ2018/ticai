import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type TouchEvent } from 'react'
import { createPortal } from 'react-dom'
import html2canvas from 'html2canvas'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMatchStore } from '../store/matchStore'
import { createBet, type Bet } from '../api/betApi'
import { buildBetPayload } from '../features/betting/betPayload'
import { flattenOptionGroups } from '../features/betting/betSlipMath'
import { useAuthStore } from '../store/authStore'
import { type MatchCard, type MatchPoolType } from '../service/matchService'
import { BetSlipFooter } from '../features/betting/BetSlipFooter'
import { MatchPoolList } from '../features/betting/MatchPoolList'
import { PlanModal } from '../features/betting/PlanModal'
import { SnapshotOverlay } from '../features/betting/SnapshotOverlay'
import { AiAnalysisPanel } from '../features/betting/AiAnalysisPanel'
import { ParlayAiAnalysisPanel } from '../features/betting/ParlayAiAnalysisPanel'
import { useMatchAiAnalysis } from '../features/betting/useMatchAiAnalysis'
import { useParlayAiAnalysis } from '../features/betting/useParlayAiAnalysis'
import { useBetSlip } from '../features/betting/useBetSlip'
import { useAutoParlay } from '../features/betting/useAutoParlay'
import { AutoParlayPanel } from '../features/betting/AutoParlayPanel'
import { type ParlayLeg } from '../features/betting/parlayModel'
import { PLAN_MODAL_ANIMATION_MS, formatMoney, getSportteryTaxInfo } from '../features/betting/betSlipMath'

const poolTabs: Array<{ key: MatchPoolType; label: string }> = [
  { key: 'had', label: '胜平负' },
  { key: 'crs', label: '比分' },
  { key: 'ttg', label: '进球数' },
  { key: 'hafu', label: '半全场' },
  { key: 'mixed', label: '混合过关' },
]

/** 把「库里最后一次写入时间」说成人话，避免用户分不清是没刷新还是爬虫没跑。 */
function formatDataAsOf(value: string | null) {
  if (!value) {
    return '—'
  }
  const stamp = Date.parse(value)
  if (!Number.isFinite(stamp)) {
    return '—'
  }

  const diff = Date.now() - stamp
  if (diff < 60_000) {
    return '刚刚'
  }
  if (diff < 3_600_000) {
    return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
  }
  if (diff < 6 * 3_600_000) {
    return `${Math.round(diff / 3_600_000)} 小时前`
  }
  return new Date(stamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

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
  const [isSavingBet, setIsSavingBet] = useState(false)
  const [saveBetHint, setSaveBetHint] = useState('')

  const navigate = useNavigate()
  const location = useLocation()
  const authToken = useAuthStore((state) => state.token)

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
  const parlayAi = useParlayAiAnalysis()
  const autoParlay = useAutoParlay()

  useEffect(() => {
    loadMatches()
  }, [loadMatches])

  // 改了选项/倍数，上一次保存留下的错误提示就过期了
  useEffect(() => {
    setSaveBetHint('')
  }, [betSlip.selectedOptionKeys, betSlip.multiple])

  // 从「我的投注」点「去投注」过来：切到对应玩法 → 回填选项 → 自动打开方案弹层
  useEffect(() => {
    const state = location.state as { applyBet?: Bet } | null
    if (!state?.applyBet) {
      return
    }
    const bet = state.applyBet
    // 立刻清掉 state，避免刷新或前进后退时重复回填
    navigate(location.pathname, { replace: true, state: null })
    void applySavedBet(bet)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  // 盘口每 30 分钟更新一轮，页面开着也要能看到新数据：
  // 每 5 分钟静默刷新一次当前玩法（只在标签页可见时），切回标签页时若数据过期也补一次。
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') {
        void loadMatches(activePool, true)
      }
    }

    const timer = window.setInterval(refreshIfVisible, 5 * 60_000)

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        return
      }
      const cache = useMatchStore.getState().poolCache[useMatchStore.getState().activePool]
      const asOf = cache.dataAsOf ? Date.parse(cache.dataAsOf) : 0
      if (!asOf || Date.now() - asOf > 5 * 60_000) {
        refreshIfVisible()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [activePool, loadMatches])

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
    parlayAi.close()
    autoParlay.close()
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
    setSaveBetHint('')
    closePlanModal()
    closeAllPanels()
    aiAnalysis.close()
    parlayAi.close()
  }

  function closePlanModal() {
    if (planModalTimerRef.current) {
      window.clearTimeout(planModalTimerRef.current)
      planModalTimerRef.current = null
    }
    parlayAi.close()
    setSaveBetHint('')
    setIsPlanModalOpen(false)
    planModalTimerRef.current = window.setTimeout(() => {
      setIsPlanModalMounted(false)
      planModalTimerRef.current = null
    }, PLAN_MODAL_ANIMATION_MS)
  }

  function openPlanModal(force = false) {
    if (!force && betSlip.selectedCount === 0) {
      setToastText('请先选择比赛')
      return
    }
    // 每次打开都是新的上下文，清掉上一次保存留下的提示
    setSaveBetHint('')
    closeAllPanels()
    aiAnalysis.close()
    parlayAi.close()
    if (planModalTimerRef.current) {
      window.clearTimeout(planModalTimerRef.current)
      planModalTimerRef.current = null
    }
    setIsPlanModalMounted(true)
    window.requestAnimationFrame(() => {
      setIsPlanModalOpen(true)
    })
  }

  /**
   * 把「我的投注」里的一单回填到投注单：
   *   - 单一玩法就切到那个玩法，混合单切到「混合过关」；
   *   - 只回填仍然在售、且选项还在的场次；
   *   - 过关方式按实际可用的场次数过滤，然后自动打开方案弹层。
   */
  async function applySavedBet(bet: Bet) {
    const pools = new Set(bet.legs.map((leg) => leg.pool))
    const targetPool: MatchPoolType = pools.size === 1 ? ([...pools][0] as MatchPoolType) : 'mixed'

    setActivePool(targetPool)
    await loadMatches(targetPool, true)

    const cards = useMatchStore.getState().poolCache[targetPool].cards
    const cardsById = new Map(cards.map((card) => [card.id, card]))
    const selections: Record<number, string[]> = {}
    let applied = 0

    for (const leg of bet.legs) {
      const card = cardsById.get(leg.sportteryMatchId)
      if (!card) {
        continue
      }
      const option = flattenOptionGroups(card).find((candidate) => candidate.key === leg.optionKey)
      if (!option || Number(option.value) < 1) {
        continue
      }
      const keys = selections[leg.sportteryMatchId] ?? []
      if (!keys.includes(leg.optionKey)) {
        keys.push(leg.optionKey)
      }
      selections[leg.sportteryMatchId] = keys
      applied += 1
    }

    if (applied === 0) {
      setToastText('这单的场次已不在售，无法回填')
      return
    }

    const matchCount = Object.keys(selections).length
    const passTypes = bet.passTypes.filter((passType) => {
      const need = Number.parseInt(passType, 10)
      return Number.isFinite(need) && need >= 2 && need <= matchCount
    })

    betSlip.applySavedPlan({ selections, passTypes, multiple: bet.multiple })
    // 直接强制打开：页面有缓存时选中数可能和上次一样（3→3），
    // 只靠「selectedCount 变化」触发会漏掉，所以这里不依赖它。
    openPlanModal(true)

    if (applied < bet.legs.length) {
      setToastText(`已回填 ${matchCount} 场，${bet.legs.length - applied} 个选项已不在售`)
    } else {
      setToastText(`已回填 ${matchCount} 场 · ${passTypes.join('、') || '自动过关'}`)
    }
  }

  /** 保存当前方案；未登录时先跳登录页，登录后回到投注页。 */
  async function saveBet() {
    if (!authToken) {
      goLogin()
      return
    }

    const payload = buildBetPayload({
      items,
      selectedOptionKeys: betSlip.selectedOptionKeys,
      passTypes: betSlip.selectedPassTypes,
      multiple: betSlip.multiple,
    })

    if (payload.legs.length === 0) {
      setSaveBetHint('没有可保存的有效选项（赔率缺失的选项会被跳过）')
      return
    }

    const matchCount = new Set(payload.legs.map((leg) => leg.sportteryMatchId)).size
    if (matchCount < 2) {
      setSaveBetHint('至少选择 2 场不同比赛才能保存（单场暂不支持）')
      return
    }
    if (payload.passTypes.length === 0) {
      setSaveBetHint('请先选择过关方式')
      return
    }

    setSaveBetHint('')
    setIsSavingBet(true)
    try {
      const bet = await createBet(authToken, payload)
      // 成功只用 toast 提示，不在弹层里常驻；弹层里的 hint 只用于错误/前置校验
      setToastText(
        bet.status === 'won'
          ? `已保存 · 已中奖 ${formatMoney(bet.payout)} 元`
          : bet.status === 'pending'
            ? '已保存到我的投注 · 待开奖'
            : '已保存到我的投注 · 未中奖',
      )
    } catch (error) {
      setSaveBetHint(error instanceof Error ? error.message : '保存失败，请稍后重试')
    } finally {
      setIsSavingBet(false)
    }
  }

  function goLogin() {
    closePlanModal()
    navigate('/login', { state: { from: '/' } })
  }

  function openAiAnalysis(item: MatchCard, anchor: HTMLButtonElement) {
    if (aiAnalysis.analysis?.key === `${activePool}:${item.id}`) {
      aiAnalysis.close()
      return
    }
    closeAllPanels()
    aiAnalysis.open(item, anchor)
  }

  function toggleParlayAi(anchor: HTMLButtonElement) {
    if (parlayAi.analysis) {
      parlayAi.close()
      return
    }

    parlayAi.open(
      {
        pool: activePool,
        passSummaryText: betSlip.passSummaryText,
        entries: betSlip.planEntries,
        matches: items,
        betAmount: betSlip.betAmount,
        maxBonus: betSlip.maxBonus,
      },
      anchor,
    )
  }

  function openMultiplePanel() {
    setIsPassPanelOpen(false)
    setMultipleDraft('')
    setIsMultiplePanelOpen(true)
  }

  /**
   * 一键串关：先跑一遍赔率 → λ → 泊松 → EV 的分析，把过程画在面板里，
   * 用户确认后再写进投注单。
   */
  function handleAutoParlay() {
    if (activeCache.loading) {
      setToastText('比赛还在加载，稍等一下')
      return
    }
    if (items.length < 2) {
      setToastText('当前玩法可选场次不足 2 场')
      return
    }

    closeAllPanels()
    aiAnalysis.close()
    parlayAi.close()
    void autoParlay.start(items, activePool)
  }

  function applyAutoParlay(legs: ParlayLeg[]) {
    betSlip.applyAutoPicks(
      legs.map((leg) => ({ matchId: leg.matchId, optionKey: leg.pick.key })),
    )
    setToastText(`已应用 ${legs.length} 场 · ${legs.length}串1`)
    autoParlay.close()
  }

  async function captureSnapshot() {
    if (isCapturingSnapshot || typeof window === 'undefined') {
      return
    }
    const captureLayer = planModalLayerRef.current
    // 只截白色方案卡，不把遮罩层和后面的赛事列表带进快照。
    const captureTarget =
      captureLayer?.querySelector<HTMLElement>('.plan-modal__card') ?? captureLayer
    if (!captureTarget) {
      setToastText('未找到可截图区域')
      return
    }
    setIsCapturingSnapshot(true)
    try {
      if (document.fonts) {
        await document.fonts.ready
      }

      // 截图按设备像素比放大输出，避免方案图在预览 / 保存后发虚。
      const captureScale = Math.min(4, Math.max(3, (window.devicePixelRatio || 1) * 2))
      const canvas = await html2canvas(captureTarget, {
        useCORS: true,
        scale: captureScale,
        backgroundColor: null,
        logging: false,
        // AI 分析 / 截图 / 关闭属于操作控件，不应出现在方案快照里。
        onclone: (clonedDocument) => {
          clonedDocument.querySelectorAll<HTMLElement>('.plan-modal__head-actions').forEach((element) => {
            element.style.display = 'none'
          })

          // 玩法、倍数等信息平时不占弹层空间，只在快照副本中展示。
          const eyebrow = clonedDocument.querySelector<HTMLElement>('.plan-modal__eyebrow')
          if (eyebrow) {
            eyebrow.textContent = `当前玩法 · ${eyebrow.dataset.poolLabel || '未知玩法'}`
          }
          clonedDocument.querySelectorAll<HTMLElement>('.plan-modal__meta').forEach((element) => {
            element.hidden = false
          })

          // 快照要完整包含所有场次：临时解除弹层最大高度与列表滚动限制。
          const snapshotCard = clonedDocument.querySelector<HTMLElement>('.plan-modal__card')
          if (snapshotCard) {
            snapshotCard.style.maxHeight = 'none'
            snapshotCard.style.height = 'auto'
          }
          const snapshotList = clonedDocument.querySelector<HTMLElement>('.plan-modal__list')
          if (snapshotList) {
            snapshotList.style.flex = '0 0 auto'
            snapshotList.style.maxHeight = 'none'
            snapshotList.style.overflowY = 'visible'
          }
        },
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

  async function refreshMatches() {
    await loadMatches(activePool, true)
    setToastText('已获取最新数据')
  }

  const dataAgeMs = activeCache.dataAsOf ? Date.now() - Date.parse(activeCache.dataAsOf) : Number.POSITIVE_INFINITY
  const isDataStale = Number.isFinite(dataAgeMs) && dataAgeMs > 45 * 60_000

  return (
    <section className="home-page">
      <h1 className="visually-hidden">竞彩足球赛程、实时赔率与投注方案</h1>
      <header className="home-page__nav">
        <div className="home-page__nav-main">
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
          <button
            type="button"
            className="home-page__auto"
            onClick={handleAutoParlay}
            disabled={activeCache.loading || items.length < 2}
            title="按当前玩法自动选出最可能的场次，串到关卡上限"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M13.2 2.2 4.6 13.7h5.6l-1 8.1 8.8-11.6h-5.7l.9-8Z" fill="currentColor" />
            </svg>
            <span>一键串关</span>
          </button>
        </div>
      </header>

      <div className={`home-page__data-bar${isDataStale ? ' is-stale' : ''}`}>
        <span className="home-page__data-text">
          {activeCache.loading && !activeCache.fetched
            ? '正在同步最新盘口…'
            : `数据更新于 ${formatDataAsOf(activeCache.dataAsOf)}`}
        </span>
        <button
          type="button"
          className="home-page__data-refresh"
          onClick={() => void refreshMatches()}
          disabled={activeCache.loading}
        >
          {activeCache.loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div className="home-page__body">
        <div className="home-page__content" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
          <MatchPoolList
            key={`${activePool}-${panelAnimTick}`}
            panelAnimClass={panelAnimClass}
            loading={activeCache.loading}
            fetched={activeCache.fetched}
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

      <ParlayAiAnalysisPanel
        analysis={parlayAi.analysis}
        anchor={parlayAi.anchor}
        onClose={parlayAi.close}
        onRetry={parlayAi.retry}
      />

      <AutoParlayPanel
        state={autoParlay.state}
        poolLabel={poolTabs.find((tab) => tab.key === activePool)?.label ?? ''}
        onApply={applyAutoParlay}
        onClose={autoParlay.close}
        onScopeChange={autoParlay.restart}
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
        poolLabel={poolTabs.find((tab) => tab.key === activePool)?.label ?? ''}
        multiple={betSlip.multiple}
        betAmount={betSlip.betAmount}
        maxBonus={betSlip.maxBonus}
        entries={betSlip.planEntries}
        isCapturing={isCapturingSnapshot}
        onCapture={captureSnapshot}
        onClose={closePlanModal}
        onAnalyze={toggleParlayAi}
        isAiActive={parlayAi.analysis !== null}
        layerRef={planModalLayerRef}
        isLoggedIn={Boolean(authToken)}
        isSaving={isSavingBet}
        saveHint={saveBetHint}
        onSaveBet={saveBet}
        onOpenLogin={goLogin}
      />

      <SnapshotOverlay
        url={snapshotUrl}
        viewerOpen={isSnapshotViewerOpen}
        onOpenViewer={openSnapshotViewer}
        onCloseViewer={closeSnapshotViewer}
        onDownload={downloadSnapshot}
        onRemove={removeSnapshot}
      />

      {/* Toast 挂到 body：首页容器有 transform（路由动画），在它里面 fixed 会被限制层级，
          弹层打开时会被压在下面 */}
      {toastText &&
        createPortal(
          <div className="home-page__toast" role="status">
            {toastText}
          </div>,
          document.body,
        )}
    </section>
  )
}
