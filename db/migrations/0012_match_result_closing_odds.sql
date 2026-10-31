-- ============================================================================
-- 0012：赛果永久保存「全玩法收盘赔率」
--
-- 背景：
--   `match_odds_snapshot` 只保留 120 天（见 db/maintenance.sql）。0011 只固化了总进球
--   一档赔率（给分布统计用）；「我的投注」要做「票面赔率 vs 开奖赔率」的奖金对比，
--   需要每场每个玩法在停售前的最后一份官方赔率，快照被裁掉后历史注单就没得比了。
--
-- 口径：
--   - 赛果首次入库时把当时最新的一份快照整包复制过来，之后不再覆盖；
--   - 迁移前 / 爬虫还没固化的行，回填当前保留期内该场最后一份快照；
--   - 赛果接口自带的 h/d/a 就是官方开奖赔率（胜平负），与快照收盘值逐场一致，
--     可以当作这套口径的校验。
--
-- 结构：与 `match_odds_snapshot.odds` 同构（{had,hhad,ttg,crs,hafu}），
--       结算与前端共用同一套 optionKey，避免再约定一份 key 映射。
-- ============================================================================

alter table match_result
  add column if not exists closing_odds jsonb,
  add column if not exists closing_odds_captured_at timestamptz;

comment on column match_result.closing_odds is
  '停售前最后一份官方赔率（全玩法，结构同 match_odds_snapshot.odds）';
comment on column match_result.closing_odds_captured_at is
  'closing_odds 对应的赔率快照时间';

-- 回填：已开奖且能关联到 match 的场次，取当前保留期内最后一份快照。
update match_result r
set closing_odds = picked.odds,
    closing_odds_captured_at = picked.captured_at
from match m
join lateral (
  select s.odds, s.captured_at
  from match_odds_snapshot s
  where s.match_id = m.id
  order by s.captured_at desc
  limit 1
) picked on true
where m.sporttery_match_id = r.sporttery_match_id
  and r.closing_odds is null
  and picked.odds is not null;
