import { marketProbabilities, readPools } from './odds.mjs'

/**
 * 推荐逻辑的回测（纯函数）。
 *
 * 口径与线上推荐保持一致：拿**开赛前最后一次**赔率快照去水 → 选「市场概率最高且赔率在带内」
 * 的选项。这里刻意不引入任何赛后信息，也不为某几场特例调参——回测是用来给用户看
 * 「这套口径大概什么水平」的，不是用来证明自己准。
 *
 * 同时给出三组对照：
 *   - 长赔（每场挑赔率最高的一项）：证明冷门的长期期望；
 *   - 赔率区间命中率：解释为什么推荐把赔率压在 3.3 以下；
 *   - 2串1 模拟：把相邻两场的首选串起来，看看串关后的真实命中率与回报。
 */

export const SAFE_TIER = { marketP: 0.42, minOdd: 1.25, maxOdd: 2.15 }
export const WIDE_TIER = { marketP: 0.36, minOdd: 1.25, maxOdd: 2.45 }

const BANDS = [
  { label: '1.25–1.60', min: 1.25, max: 1.6 },
  { label: '1.60–2.00', min: 1.6, max: 2.0 },
  { label: '2.00–2.60', min: 2.0, max: 2.6 },
  { label: '2.60–3.40', min: 2.6, max: 3.4 },
  { label: '3.40–5.00', min: 3.4, max: 5.0 },
  { label: '5.00 以上', min: 5.0, max: Number.POSITIVE_INFINITY },
]

function summarize(rows) {
  if (rows.length === 0) {
    return { n: 0, hits: 0, hitRate: 0, roi: 0, avgOdd: 0 }
  }
  const hits = rows.filter((row) => row.hit).length
  const profit = rows.reduce((total, row) => total + (row.hit ? row.odd - 1 : -1), 0)
  return {
    n: rows.length,
    hits,
    hitRate: Number((hits / rows.length).toFixed(4)),
    roi: Number((profit / rows.length).toFixed(4)),
    avgOdd: Number((rows.reduce((total, row) => total + row.odd, 0) / rows.length).toFixed(3)),
  }
}

function inTier(candidate, tier) {
  return (
    candidate.marketP >= tier.marketP &&
    candidate.odd >= tier.minOdd &&
    candidate.odd <= tier.maxOdd
  )
}

/**
 * @param {Array} samples data.loadBacktestSamples() 的输出
 */
export function runBacktest(samples) {
  const usable = []
  const optionRows = []
  const longshotRows = []

  for (const sample of samples) {
    const pools = readPools(sample.odds)
    const market = marketProbabilities(pools)
    if (!market.had || !sample.hadResult) {
      continue
    }
    usable.push(sample)

    const options = ['h', 'd', 'a']
      .map((key) => ({ key, odd: pools.had[key], marketP: market.had[key] }))
      .filter((option) => option.odd > 1 && option.marketP > 0)

    if (options.length < 3) {
      continue
    }

    for (const option of options) {
      optionRows.push({
        odd: option.odd,
        hit: option.key === sample.hadResult,
        kickoffAt: sample.kickoffAt,
      })
    }

    const favourite = [...options].sort((left, right) => right.marketP - left.marketP)[0]
    const longest = [...options].sort((left, right) => right.odd - left.odd)[0]
    if (longest.odd >= 4) {
      longshotRows.push({ odd: longest.odd, hit: longest.key === sample.hadResult })
    }

    sample.__favourite = favourite
  }

  const safePicks = []
  const widePicks = []
  for (const sample of usable) {
    const favourite = sample.__favourite
    if (!favourite) {
      continue
    }
    const hit = favourite.key === sample.hadResult
    const row = { odd: favourite.odd, hit, kickoffAt: sample.kickoffAt, matchId: sample.matchId }
    if (inTier(favourite, SAFE_TIER)) {
      safePicks.push(row)
    } else if (inTier(favourite, WIDE_TIER)) {
      widePicks.push(row)
    }
  }

  // 2串1：按开赛时间相邻两两配对（同一注只覆盖两场）
  const ordered = [...safePicks].sort((left, right) => (left.kickoffAt < right.kickoffAt ? -1 : 1))
  const doubles = []
  for (let i = 0; i + 1 < ordered.length; i += 2) {
    const totalOdd = ordered[i].odd * ordered[i + 1].odd
    const hit = ordered[i].hit && ordered[i + 1].hit
    doubles.push({ odd: totalOdd, hit })
  }

  const bands = BANDS.map((band) => {
    const rows = optionRows.filter((row) => row.odd >= band.min && row.odd < band.max)
    return { label: band.label, ...summarize(rows) }
  })

  const dates = usable
    .map((sample) => sample.matchDate)
    .filter(Boolean)
    .sort()

  return {
    window: {
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
      matches: usable.length,
    },
    singles: summarize(safePicks),
    wideSingles: summarize(widePicks),
    doubles: summarize(doubles),
    longshot: summarize(longshotRows),
    bands,
    note: '回测只用开赛前最后一次赔率快照，按「市场概率最高 + 赔率 1.25–2.15」选场；不含任何赛后信息。样本只有几天，波动很大，只用来对比高赔与低赔的相对水平，不代表长期收益。',
  }
}
