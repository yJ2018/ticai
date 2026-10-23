/**
 * 本地状态收敛：已开赛的比赛不应再显示为「在售」。
 *
 * 竞彩单场在开赛时停售，这条规则不依赖上游接口，
 * 所以这个任务**不受销售时段闸门限制**——它只是把本地状态改对，
 * 不产生任何对外请求。
 *
 * 上游的 sell_status 仍然是权威来源：下一轮 matches 抓取会覆盖成上游值。
 */
export async function expireStartedMatches({ pool }) {
  const result = await pool.query(`
    update match
    set sell_status = 'closed'
    where sell_status = 'on_sale'
      and kickoff_at <= now()
  `)

  return { closed: result.rowCount ?? 0 }
}
