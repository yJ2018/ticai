import { crawlDetails } from './details.mjs'
import { expireStartedMatches } from './expire.mjs'
import { crawlHistory } from './history.mjs'
import { crawlMatches } from './matches.mjs'
import { crawlMatchResults } from './results.mjs'

/**
 * 每日预热：只刷**体彩官网**有的那部分数据。
 *
 *   expire   本地状态收敛（不发请求）
 *   matches  在售赛程 + 赔率
 *   results  赛果开奖（比分 + 各玩法结果）
 *   history  四彩种开奖
 *   details  伤停 / 交锋 / 近况 / 排名（7 个官方源，默认只取伤停）
 *
 * 不包含阵容——阵容来自 500.com，属于第三方数据，
 * 且只在赛前 1 小时才有意义，由 lineups 任务按窗口单独负责。
 *
 * 这个组合会在 09:00（开盘前两小时）跑一轮，所以**不受销售时段闸门限制**。
 */
export async function crawlOfficialData({ pool, config }) {
  const expire = await expireStartedMatches({ pool })
  const matches = await crawlMatches({ pool, config })
  const results = await crawlMatchResults({ pool, config, days: 3 })
  const history = await crawlHistory({ pool, config })
  const details = await crawlDetails({ pool, config, limit: config.detailsLimit })

  return { expire, matches, results, history, details }
}

export function describeOfficialResult(result) {
  const history = result.history
    .map((item) => `${item.game}:${item.error ? `失败(${item.error})` : item.saved}`)
    .join(' ')

  return [
    `停售 ${result.expire.closed}`,
    `赛程 ${result.matches.matches}（赔率变更 ${result.matches.changed}）`,
    `赛果 ${result.results.matches}（回写比分 ${result.results.matchesSynced}）`,
    history,
    `伤停 ${result.details.injuries} / 比分 ${result.details.results}`,
  ].join(' · ')
}
