import {
  buildCombinationCandidates,
  parseDigitValue,
  rankNextDigits,
  resolvePredictionConfig,
  sortChronological,
} from './history-prediction.mjs'

/**
 * 逐期参考归档（walk-forward）。
 *
 * 已有的 `analyzeHistoryPrediction` 只输出「现在这一期」的参考 + 全量回测汇总；
 * 这里把回测过程本身展开成可入库的逐期记录：
 *   第 N 期参考 = 只用第 1..N-1 期数据算出来的排名（和线上当期预测同一套打分）；
 *   第 N 期开奖后逐位核对 Top1 / Top3 / 组合，得到可以按期回看的命中与偏差。
 *
 * 关键约束（与 history-prediction.mjs 的口径保持一致）：
 *   - 打分、排序、组合 beam search 全部复用同一批函数，不复制一套实现；
 *   - 前缀少于 minTrainingSize（默认 30）的期次不产出记录，和回测样本口径一致；
 *   - 七星彩末位允许 10–14：实际号码照常核对（Top3 不可能命中），但进入打分序列的
 *     仍然只有 0–9，和现有预测一致。
 *
 * 增量：`sinceSeq` + 上一份 counters/recent 可以从任意一期往后续算，只对新区间做排名，
 * 历史前缀只做一次线性 append；开奖后补一期不会重跑全量。
 */

export const PREDICTION_TRACK_VERSION = 'track-1'
export const PREDICTION_BASELINE = Object.freeze({ top1: 0.1, top3: 0.3 })
export const PREDICTION_TRACK_WINDOWS = [30, 100, 300, 1000]
export const PREDICTION_TRACK_ROLLING_LIMIT = 120
/** 汇总表里保留最近多少期的逐期命中（用于 30/100/300/1000 窗口与滚动曲线） */
export const PREDICTION_TRACK_RECENT_LIMIT = 1000

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
const MAX_POSITIONS = 7

export function createEmptyTrackCounters(positionCount) {
  const count = clampPositionCount(positionCount)
  return {
    samples: 0,
    top1Hits: 0,
    top3Hits: 0,
    positions: Array.from({ length: count }, (_, position) => ({
      position,
      samples: 0,
      top1Hits: 0,
      top3Hits: 0,
      rankSamples: 0,
      rankSum: 0,
      digitSamples: 0,
    })),
    digits: Array.from({ length: count }, () =>
      DIGITS.map((digit) => ({ digit, picked: 0, actual: 0 })),
    ),
    combos: {
      issues: 0,
      samples: 0,
      exactHits: 0,
      exactIssues: 0,
      matchedSum: 0,
      best: 0,
      distribution: Array.from({ length: count + 1 }, () => 0),
    },
  }
}

/**
 * 逐期归档计算。
 *
 * @param entries [{ issue, issueSeq, drawDate, numbers: string[] }]（顺序不限，内部按 issue 排）
 * @param options {
 *   positionCount, markovOrder, scoreWeights,
 *   sinceSeq?: 只产出 issueSeq 大于它的记录（增量补算）
 *   counters?: 上一份累计计数（must match sinceSeq）
 *   recent?: 上一份最近命中数组
 * }
 */
export function buildPredictionTrack(entries, options = {}) {
  const config = resolvePredictionConfig(options)
  const sorted = sortChronological(entries)
  const positionCount = clampPositionCount(options.positionCount)
  const sinceSeq = toFiniteNumber(options.sinceSeq, 0)
  const counters = normalizeCounters(options.counters, positionCount)
  const recent = normalizeRecent(options.recent)
  const prefixes = Array.from({ length: positionCount }, () => [])
  // 与 runBacktest 同一口径：历史很短时 minTrainingSize 会自适应到「总期数 - 1」，
  // 否则小样本彩种（或测试夹具）会一条记录都不产出。
  const minTrainingByPosition = Array.from({ length: positionCount }, (_, position) => {
    const total = sorted.reduce(
      (count, entry) => count + (parseDigitValue(entry.numbers?.[position]) !== null ? 1 : 0),
      0,
    )
    return Math.min(config.minTrainingSize, Math.max(10, total - 1))
  })
  const items = []

  let previous = null
  let firstTracked = null
  let lastTracked = null

  for (const entry of sorted) {
    const issueSeq = toFiniteNumber(entry.issueSeq, Number(entry.issue))
    if (!Number.isFinite(issueSeq) || issueSeq <= 0) {
      continue
    }

    const issue = String(entry.issue ?? issueSeq)
    const actuals = Array.from({ length: positionCount }, (_, position) =>
      parseTrackDigit(entry.numbers?.[position]),
    )
    const trackable = actuals.every((value) => value !== null)
    const ready = prefixes.every(
      (prefix, position) => prefix.length >= minTrainingByPosition[position],
    )

    if (issueSeq > sinceSeq && ready && trackable) {
      // 直接复用冻结的 rankNextDigits：归档和快照/回测是同一份打分，不复制公式。
      const rankedByPosition = prefixes.map((prefix) => rankNextDigits(prefix, config))
      const positions = rankedByPosition.map((ranked, position) => {
        const picks = ranked.slice(0, config.combinationPoolSize).map((item) => item.digit)
        const actual = actuals[position]
        const rankIndex = ranked.findIndex((item) => item.digit === actual)
        return {
          position,
          picks,
          actual,
          // 1–10；实际号码是 10–14 时不在 0–9 排名里，记 null
          rank: rankIndex >= 0 ? rankIndex + 1 : null,
          hitTop1: picks[0] === actual,
          hitTop3: picks.includes(actual),
        }
      })

      // 组合参考：和快照里 buildCombinationCandidates 用的是同一套 beam search
      const combinations = buildCombinationCandidates(
        rankedByPosition.map((ranked) => ({ candidates: ranked.slice(0, 5) })),
        config,
      ).map((item) => ({
        value: item.value,
        score: item.score,
        matched: positions.reduce(
          (total, positionItem, position) =>
            total + (Number(item.value[position]) === positionItem.actual ? 1 : 0),
          0,
        ),
      }))

      const top1Hits = positions.filter((item) => item.hitTop1).length
      const top3Hits = positions.filter((item) => item.hitTop3).length
      const bestComboMatch = combinations.reduce((best, item) => Math.max(best, item.matched), 0)
      const record = {
        issue,
        issueSeq,
        drawDate: entry.drawDate ?? null,
        throughIssue: previous?.issue ?? null,
        throughIssueSeq: previous?.issueSeq ?? null,
        actual: actuals,
        positions,
        combinations,
        top1Hits,
        top3Hits,
        bestComboMatch,
      }

      items.push(record)
      accumulate(counters, record, positionCount)
      recent.push({
        issue,
        seq: issueSeq,
        top1: top1Hits,
        top3: top3Hits,
        mask: positions.reduce(
          (mask, item, position) => mask | (item.hitTop3 ? 1 << position : 0),
          0,
        ),
        top1Mask: positions.reduce(
          (mask, item, position) => mask | (item.hitTop1 ? 1 << position : 0),
          0,
        ),
      })
      if (recent.length > PREDICTION_TRACK_RECENT_LIMIT) {
        recent.splice(0, recent.length - PREDICTION_TRACK_RECENT_LIMIT)
      }

      firstTracked ??= record
      lastTracked = record
    }

    // 前缀只喂单数字（0–9），与现有预测算法的过滤口径一致；10–14 只参与核对
    for (let position = 0; position < positionCount; position += 1) {
      const actual = actuals[position]
      if (actual !== null && actual <= 9) {
        prefixes[position].push(actual)
      }
    }

    previous = { issue, issueSeq }
  }

  return {
    version: PREDICTION_TRACK_VERSION,
    config,
    positionCount,
    items,
    counters,
    recent,
    firstTracked,
    lastTracked,
    sinceSeq,
  }
}

/** 把累计计数与最近命中共算成接口直出的统计对象 */
export function buildTrackStat({
  counters,
  recent,
  positionCount,
  configKey,
  sample,
  trackVersion = PREDICTION_TRACK_VERSION,
}) {
  const count = clampPositionCount(positionCount)
  const normalized = normalizeCounters(counters, count)
  const recentList = normalizeRecent(recent)
  const samples = normalized.samples

  const positions = normalized.positions.map((position) => {
    const top1Rate = safeRate(position.top1Hits, position.samples)
    const top3Rate = safeRate(position.top3Hits, position.samples)
    return {
      position: position.position,
      samples: position.samples,
      top1Hits: position.top1Hits,
      top3Hits: position.top3Hits,
      top1Rate,
      top3Rate,
      top1Deviation: top1Rate - PREDICTION_BASELINE.top1,
      top3Deviation: top3Rate - PREDICTION_BASELINE.top3,
      top1Lift: safeRate(top1Rate, PREDICTION_BASELINE.top1),
      top3Lift: safeRate(top3Rate, PREDICTION_BASELINE.top3),
      avgRank: position.rankSamples > 0 ? position.rankSum / position.rankSamples : null,
      recentTop3Rate: recentMaskRate(recentList, position.position, 100, 'mask'),
      recentTop1Rate: recentMaskRate(recentList, position.position, 100, 'top1Mask'),
    }
  })

  const top1Rate = safeRate(normalized.top1Hits, samples * count)
  const top3Rate = safeRate(normalized.top3Hits, samples * count)
  const rankSamples = normalized.positions.reduce((sum, item) => sum + item.rankSamples, 0)
  const rankSum = normalized.positions.reduce((sum, item) => sum + item.rankSum, 0)

  const windows = PREDICTION_TRACK_WINDOWS.map((window) => {
    const slice = recentList.slice(-window)
    const total = slice.length * count
    return {
      window,
      samples: slice.length,
      top1Hits: slice.reduce((sum, item) => sum + item.top1, 0),
      top3Hits: slice.reduce((sum, item) => sum + item.top3, 0),
      top1Rate: safeRate(
        slice.reduce((sum, item) => sum + item.top1, 0),
        total,
      ),
      top3Rate: safeRate(
        slice.reduce((sum, item) => sum + item.top3, 0),
        total,
      ),
    }
  })

  const digits = normalized.digits.map((row, position) => {
    const positionSamples = normalized.positions[position]?.samples ?? 0
    const digitSamples = normalized.positions[position]?.digitSamples ?? 0
    const pickedDenominator = positionSamples * 3
    return row.map((item) => {
      const pickedRate = safeRate(item.picked, pickedDenominator)
      const actualRate = safeRate(item.actual, digitSamples)
      return {
        digit: item.digit,
        picked: item.picked,
        pickedRate,
        actual: item.actual,
        actualRate,
        // 正数 = 模型比实际更爱选这个数字（高估），负数 = 低估
        deviation: pickedRate - actualRate,
      }
    })
  })

  const combo = normalized.combos
  const distribution = combo.distribution.map((countValue, matched) => ({
    matched,
    count: countValue,
    rate: safeRate(countValue, combo.samples),
  }))

  return {
    version: trackVersion,
    configKey,
    positionCount: count,
    baseline: { ...PREDICTION_BASELINE },
    sample: {
      ...sample,
      drawCount: samples,
    },
    overall: {
      samples,
      positions: count,
      top1Hits: normalized.top1Hits,
      top3Hits: normalized.top3Hits,
      top1Rate,
      top3Rate,
      top1Deviation: top1Rate - PREDICTION_BASELINE.top1,
      top3Deviation: top3Rate - PREDICTION_BASELINE.top3,
      top1Lift: safeRate(top1Rate, PREDICTION_BASELINE.top1),
      top3Lift: safeRate(top3Rate, PREDICTION_BASELINE.top3),
      // 每期平均命中几位（0–5），双色球式直觉指标
      avgPositionHits: safeRate(normalized.top3Hits, samples),
      avgRank: rankSamples > 0 ? rankSum / rankSamples : null,
    },
    positions,
    windows,
    digits,
    combinations: {
      issues: combo.issues,
      samples: combo.samples,
      exactHits: combo.exactHits,
      exactIssues: combo.exactIssues,
      exactRate: safeRate(combo.exactHits, combo.samples),
      avgMatched: safeRate(combo.matchedSum, combo.samples),
      best: combo.best,
      distribution,
    },
    rolling: recentList.slice(-PREDICTION_TRACK_ROLLING_LIMIT).map((item) => ({
      issue: item.issue,
      issueSeq: item.seq,
      top1: item.top1,
      top3: item.top3,
    })),
    recentCoverage: recentList.length,
  }
}

function accumulate(counters, record, positionCount) {
  counters.samples += 1
  counters.top1Hits += record.top1Hits
  counters.top3Hits += record.top3Hits

  for (let position = 0; position < positionCount; position += 1) {
    const slot = counters.positions[position]
    const item = record.positions[position]
    slot.samples += 1
    if (item.hitTop1) {
      slot.top1Hits += 1
    }
    if (item.hitTop3) {
      slot.top3Hits += 1
    }
    if (item.rank !== null) {
      slot.rankSamples += 1
      slot.rankSum += item.rank
    }
    if (item.actual !== null && item.actual <= 9) {
      slot.digitSamples += 1
      counters.digits[position][item.actual].actual += 1
    }
    for (const digit of item.picks) {
      counters.digits[position][digit].picked += 1
    }
  }

  const combo = counters.combos
  combo.issues += 1
  combo.samples += record.combinations.length
  for (const item of record.combinations) {
    combo.matchedSum += item.matched
    combo.distribution[item.matched] = (combo.distribution[item.matched] ?? 0) + 1
    combo.best = Math.max(combo.best, item.matched)
    if (item.matched === positionCount) {
      combo.exactHits += 1
    }
  }
  if (record.bestComboMatch === positionCount) {
    combo.exactIssues += 1
  }
}

function normalizeCounters(input, positionCount) {
  const base = createEmptyTrackCounters(positionCount)
  if (!input || typeof input !== 'object') {
    return base
  }

  base.samples = toCount(input.samples)
  base.top1Hits = toCount(input.top1Hits)
  base.top3Hits = toCount(input.top3Hits)

  if (Array.isArray(input.positions)) {
    for (let position = 0; position < positionCount; position += 1) {
      const source = input.positions[position]
      if (!source) {
        continue
      }
      base.positions[position] = {
        position,
        samples: toCount(source.samples),
        top1Hits: toCount(source.top1Hits),
        top3Hits: toCount(source.top3Hits),
        rankSamples: toCount(source.rankSamples),
        rankSum: toCount(source.rankSum),
        digitSamples: toCount(source.digitSamples),
      }
    }
  }

  if (Array.isArray(input.digits)) {
    for (let position = 0; position < positionCount; position += 1) {
      const row = input.digits[position]
      if (!Array.isArray(row)) {
        continue
      }
      base.digits[position] = DIGITS.map((digit) => ({
        digit,
        picked: toCount(row[digit]?.picked),
        actual: toCount(row[digit]?.actual),
      }))
    }
  }

  if (input.combos && typeof input.combos === 'object') {
    base.combos = {
      issues: toCount(input.combos.issues),
      samples: toCount(input.combos.samples),
      exactHits: toCount(input.combos.exactHits),
      exactIssues: toCount(input.combos.exactIssues),
      matchedSum: toCount(input.combos.matchedSum),
      best: toCount(input.combos.best),
      distribution: Array.from({ length: positionCount + 1 }, (_, index) =>
        toCount(input.combos.distribution?.[index]),
      ),
    }
  }

  return base
}

function normalizeRecent(input) {
  if (!Array.isArray(input)) {
    return []
  }
  return input
    .filter(
      (item) =>
        item &&
        typeof item.issue === 'string' &&
        Number.isFinite(Number(item.seq)) &&
        Number.isFinite(Number(item.top1)) &&
        Number.isFinite(Number(item.top3)),
    )
    .map((item) => ({
      issue: item.issue,
      seq: Number(item.seq),
      top1: Number(item.top1),
      top3: Number(item.top3),
      mask: toCount(item.mask),
      top1Mask: toCount(item.top1Mask),
    }))
    .slice(-PREDICTION_TRACK_RECENT_LIMIT)
}

function recentMaskRate(recent, position, limit, key) {
  const slice = recent.slice(-limit)
  if (slice.length === 0) {
    return 0
  }
  const bit = 1 << position
  return slice.filter((item) => (item[key] & bit) !== 0).length / slice.length
}

/** 实际号码：0–9 之外，七星彩末位允许 10–14 */
function parseTrackDigit(value) {
  const single = parseDigitValue(value)
  if (single !== null) {
    return single
  }
  const text = String(value ?? '').trim()
  if (!/^\d{1,2}$/.test(text)) {
    return null
  }
  const numeric = Number(text)
  return numeric >= 10 && numeric <= 14 ? numeric : null
}

function clampPositionCount(value) {
  const numeric = Math.floor(Number(value))
  if (!Number.isFinite(numeric)) {
    return 5
  }
  return Math.min(Math.max(numeric, 1), MAX_POSITIONS)
}

function toFiniteNumber(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function toCount(value) {
  const numeric = Math.floor(Number(value))
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
}

function safeRate(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return 0
  }
  return value / total
}
