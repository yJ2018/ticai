-- ============================================================================
-- 0011：赛果永久保存「总进球」赛前赔率
--
-- 背景：
--   `match_odds_snapshot` 只保留 120 天（见 db/maintenance.sql），而
--   「开奖记录 × 总进球赔率」的分布统计要求不限时间回看。赛果入库时把该场
--   最后一份 TTG 赔率复制到 `match_result`，快照被裁掉后仍能统计。
--
-- 口径：
--   - 只在第一次写入时保存，之后不覆盖 —— 得到的是停售前最后一份赔率；
--   - 赔率对象原样保存（s0..s7），与前端玩法 key / 结算 key 一致；
--   - 旧场次从当前仍在保留期内的快照回填，超出 120 天的无法找回。
-- ============================================================================

alter table match_result
  add column if not exists ttg_odds jsonb,
  add column if not exists ttg_odds_captured_at timestamptz;

comment on column match_result.ttg_odds is
  '赛果入库时的最后一份总进球赔率（s0..s7）；赔率快照被裁剪后仍可用于历史统计';
comment on column match_result.ttg_odds_captured_at is
  'ttg_odds 对应的赔率快照时间';

-- 回填：已开奖且能关联到 match 的场次，取当前保留期内最后一份快照。
update match_result r
set ttg_odds = picked.ttg_odds,
    ttg_odds_captured_at = picked.captured_at
from match m
join lateral (
  select s.odds->'ttg' as ttg_odds, s.captured_at
  from match_odds_snapshot s
  where s.match_id = m.id
  order by s.captured_at desc
  limit 1
) picked on true
where m.sporttery_match_id = r.sporttery_match_id
  and r.ttg_odds is null
  and picked.ttg_odds is not null;
