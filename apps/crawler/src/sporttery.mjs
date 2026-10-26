import { fetchJson } from './http.mjs'

/** 体彩上游接口封装。只负责"取回来并做基本校验"，转换交给 normalize.mjs。 */

const MATCH_PATH = '/gateway/uniform/football/getMatchCalculatorV1.qry'
const HISTORY_PATH = '/gateway/lottery/getHistoryPageListV1.qry'
const MATCH_DATA = '/gateway/uniform/football'
/** 竞彩足球「赛果开奖」：官网 /jc/zqsgkj/ 背后就是这个接口。 */
const MATCH_RESULT_PATH = '/gateway/uniform/football/getUniformMatchResultV1.qry'

/**
 * 在售赛程 + 赔率。
 * 不传 poolCode 就是全部玩法（旧 BFF 里 mixed 走的就是这条路），一次拿全。
 */
export async function fetchMatches(config, { fetchImpl } = {}) {
  const query = new URLSearchParams({ channel: 'c' })
  const json = await fetchJson(`${config.sportteryBase}${MATCH_PATH}?${query.toString()}`, {
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    fetchImpl,
  })

  if (!json || typeof json !== 'object') {
    throw new Error('赛程接口返回结构异常')
  }
  if (json.success === false) {
    throw new Error(`赛程接口返回失败：${json.errorMessage || json.errorCode || '未知原因'}`)
  }

  const groups = json.value?.matchInfoList
  if (!Array.isArray(groups)) {
    throw new Error('赛程接口缺少 matchInfoList')
  }

  return groups
}

/**
 * 竞彩足球赛果开奖。
 *
 * 必须带日期区间（上游会直接报 20012），一次最多 100 条；
 * 返回里 matchResult 才是比赛列表，leagueList 是筛选器用的字典。
 */
export async function fetchMatchResults(config, { begin, end, pageNo = 1, pageSize = 100, fetchImpl } = {}) {
  if (!begin || !end) {
    throw new Error('赛果接口必须指定 begin/end 日期')
  }

  const query = new URLSearchParams({
    matchBeginDate: begin,
    matchEndDate: end,
    leagueId: '',
    pageSize: String(pageSize),
    pageNo: String(pageNo),
    isFix: '0',
    matchPage: '1',
    pcOrWap: '1',
  })

  const json = await fetchJson(`${config.sportteryBase}${MATCH_RESULT_PATH}?${query.toString()}`, {
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    fetchImpl,
    headers: { referer: 'https://www.lottery.gov.cn/jc/zqsgkj/' },
  })

  if (!json || typeof json !== 'object') {
    throw new Error('赛果接口返回结构异常')
  }
  if (json.success === false) {
    throw new Error(`赛果接口返回失败：${json.errorMessage || json.errorCode || '未知原因'}`)
  }

  const value = json.value ?? {}
  if (!Array.isArray(value.matchResult)) {
    throw new Error('赛果接口缺少 value.matchResult')
  }

  return {
    list: value.matchResult,
    pageNo: Number(value.pageNo) || Number(pageNo) || 1,
    pages: Number(value.pages) || 1,
    total: Number(value.total) || value.matchResult.length,
    lastUpdateTime: value.lastUpdateTime ?? null,
  }
}

/** 开奖分页。gameNo 是彩种编号，pageSize 最大 100。 */
export async function fetchHistoryPage(config, { gameNo, pageNo, pageSize, fetchImpl } = {}) {
  const query = new URLSearchParams({
    gameNo,
    provinceId: '0',
    pageSize: String(pageSize ?? config.historyPageSize),
    isVerify: '1',
    termLimits: '0',
    pageNo: String(pageNo ?? 1),
  })

  const json = await fetchJson(`${config.sportteryBase}${HISTORY_PATH}?${query.toString()}`, {
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    fetchImpl,
  })

  if (!json || typeof json !== 'object') {
    throw new Error('开奖接口返回结构异常')
  }
  if (json.success === false) {
    throw new Error(`开奖接口返回失败：${json.errorMessage || json.errorCode || '未知原因'}`)
  }

  const value = json.value
  if (!value || !Array.isArray(value.list)) {
    throw new Error('开奖接口缺少 value.list')
  }

  return {
    list: value.list,
    pageNo: Number(value.pageNo) || Number(pageNo) || 1,
    pages: Number(value.pages) || 1,
    total: Number(value.total) || value.list.length,
  }
}

/**
 * 对战数据页的 7 个订阅源。
 *
 * 关键参数：URL 里的 `mid` 对应 **sportteryMatchId**（体彩官方赛事 ID），
 * 不是 `matchId`（那是外部数据商的 ID）。搞错这个，接口全部返回空 value。
 */
export const MATCH_FEEDS = {
  history: { path: '/getResultHistoryV1.qry', label: '历史交锋', extra: '&termLimits=5&tournamentFlag=0&homeAwayFlag=0' },
  injury: { path: '/getInjurySuspensionV1.qry', label: '伤停', extra: '' },
  result: { path: '/getMatchResultV1.qry', label: '近期赛果', extra: '&termLimits=10&tournamentFlag=0&homeAwayFlag=0' },
  future: { path: '/getFutureMatchesV1.qry', label: '未来赛程', extra: '&termLimits=4' },
  feature: { path: '/getMatchFeatureV1.qry', label: '特征', extra: '&termLimits=10' },
  tables: { path: '/getMatchTablesV1.qry', label: '积分榜', extra: '' },
  shooter: { path: '/getMatchPlayerV1.qry', label: '射手', extra: '&termLimits=3' },
}

export async function fetchMatchFeed(config, { sportteryMatchId, feed, fetchImpl } = {}) {
  const meta = MATCH_FEEDS[feed]
  if (!meta) {
    throw new Error(`未知订阅源：${feed}`)
  }

  const url =
    `${config.sportteryBase}${MATCH_DATA}${meta.path}` +
    `?sportteryMatchId=${encodeURIComponent(sportteryMatchId)}${meta.extra}`

  const json = await fetchJson(url, {
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    fetchImpl,
  })

  if (!json || typeof json !== 'object') {
    throw new Error(`${meta.label}接口返回结构异常`)
  }
  if (json.success === false) {
    throw new Error(`${meta.label}接口返回失败：${json.errorMessage || json.errorCode || '未知原因'}`)
  }

  return json.value ?? {}
}
