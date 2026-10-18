import { type MouseEvent, type PointerEvent } from 'react'
import { formatPassType, getPassNeed } from './betSlipMath'

type BetSlipFooterProps = {
  selectedCount: number
  passTypeOptions: string[]
  selectedPassTypes: string[]
  onTogglePassType: (passType: string) => void
  isPassPanelOpen: boolean
  onTogglePassPanel: () => void
  isMultiplePanelOpen: boolean
  onOpenMultiplePanel: () => void
  multiple: number
  multipleDraft: string
  onAppendMultipleDigit: (digit: string) => void
  onRemoveMultipleDigit: () => void
  onConfirmMultiple: () => void
  betAmount: number
  maxBonus: number
  onShowMaxBonusTax: () => void
  onClear: () => void
  onOpenPlan: () => void
  onPointerDownCapture: (event: PointerEvent<HTMLElement>) => void
  onClickCapture: (event: MouseEvent<HTMLElement>) => void
}

const NUMBER_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/** 底部投注栏：过关方式、倍数键盘、金额与最高奖金、查看方案 */
export function BetSlipFooter({
  selectedCount,
  passTypeOptions,
  selectedPassTypes,
  onTogglePassType,
  isPassPanelOpen,
  onTogglePassPanel,
  isMultiplePanelOpen,
  onOpenMultiplePanel,
  multiple,
  multipleDraft,
  onAppendMultipleDigit,
  onRemoveMultipleDigit,
  onConfirmMultiple,
  betAmount,
  maxBonus,
  onShowMaxBonusTax,
  onClear,
  onOpenPlan,
  onPointerDownCapture,
  onClickCapture,
}: BetSlipFooterProps) {
  return (
    <footer
      className={`home-page__actions ${isPassPanelOpen || isMultiplePanelOpen ? 'is-panel-open' : ''}`}
      onPointerDownCapture={onPointerDownCapture}
      onClickCapture={onClickCapture}
    >
      <div className="home-page__bet-row home-page__bet-row--top">
        <div className="bet-fixed-meta bet-fixed-meta--single">
          <strong>已选 {selectedCount}</strong>
        </div>
        <div className="bet-pass">
          <button
            type="button"
            className={`bet-pass__trigger ${isPassPanelOpen ? 'is-open' : ''}`}
            onClick={onTogglePassPanel}
          >
            <span className="bet-pass__trigger-text">过关选择</span>
          </button>
          <div className={`bet-pass__panel ${isPassPanelOpen ? 'is-open' : ''}`}>
            {passTypeOptions.map((option) => {
              const disabled = getPassNeed(option) > selectedCount
              const active = selectedPassTypes.includes(option)
              return (
                <button
                  key={option}
                  type="button"
                  disabled={disabled}
                  className={`bet-pass__option ${active ? 'is-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => onTogglePassType(option)}
                >
                  {formatPassType(option)}
                </button>
              )
            })}
          </div>
        </div>
        <button type="button" className="btn-ghost btn-action-equal" onClick={onClear}>
          清空
        </button>
      </div>
      <div className="home-page__bet-row home-page__bet-row--bottom">
        <div className="bet-multiple bet-fixed-meta bet-fixed-meta--single">
          <button type="button" className="bet-multiple__trigger" onClick={onOpenMultiplePanel}>
            {multiple}倍
          </button>
          <div className={`bet-multiple__panel ${isMultiplePanelOpen ? 'is-open' : ''}`}>
            <div className="bet-multiple__display">
              <span className="bet-multiple__display-label">当前值：</span>
              <strong>{multipleDraft || String(multiple)}</strong>
            </div>
            {NUMBER_KEYS.map((digit) => (
              <button
                key={digit}
                type="button"
                className="bet-multiple__key"
                onClick={() => onAppendMultipleDigit(digit)}
              >
                {digit}
              </button>
            ))}
            <button type="button" className="bet-multiple__key" onClick={onRemoveMultipleDigit}>
              删除
            </button>
            <button
              type="button"
              className="bet-multiple__key"
              onClick={() => onAppendMultipleDigit('0')}
            >
              0
            </button>
            <button
              type="button"
              className="bet-multiple__key bet-multiple__key--confirm"
              onClick={onConfirmMultiple}
            >
              确认
            </button>
          </div>
        </div>
        <div className="bet-summary">
          <div className="bet-meta">
            <span className="bet-meta__label-small">投注金额</span> <strong>{betAmount}</strong> 元
          </div>
          <button type="button" className="bet-meta bet-meta--button" onClick={onShowMaxBonusTax}>
            <span className="bet-meta__label-small">理论最高奖金</span> <strong>{maxBonus}</strong> 元
          </button>
        </div>
        <button type="button" className="btn-primary btn-action-equal bet-plan__trigger" onClick={onOpenPlan}>
          查看方案
        </button>
      </div>
    </footer>
  )
}
