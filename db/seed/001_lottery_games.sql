-- ============================================================================
-- 彩种种子数据
--
-- gameNo 已于 2026-10-22 用真实接口逐个验证（getHistoryPageListV1）：
--   35     → 排列3     3 位数字，共 7755 期
--   350133 → 排列5     5 位数字，共 7755 期
--   85     → 超级大乐透 5+2，共 2938 期
--   04     → 七星彩     7 位数字，共 3404 期
--
-- 排列3 与 排列5 共用期号体系（同期号同为 26280），所以主键必须是 (game_no, issue)。
-- draw_weekdays 按官网公告填写，如有调整直接重跑本文件即可（upsert）。
-- ============================================================================

insert into lottery_game
  (game_no, game_key, name, is_positional, digit_count, main_count, main_max, extra_count, extra_max, draw_weekdays)
values
  ('350133', 'pl5', '排列5',       true,  5,    5, 9,  0, null, '{1,2,3,4,5,6,7}'),
  ('35',     'pl3', '排列3',       true,  3,    3, 9,  0, null, '{1,2,3,4,5,6,7}'),
  ('85',     'dlt', '超级大乐透',  false, null, 5, 35, 2, 12,   '{1,3,6}'),
  ('04',     'qxc', '七星彩',      true,  7,    7, 9,  0, null, '{2,5,7}')
on conflict (game_no) do update set
  game_key      = excluded.game_key,
  name          = excluded.name,
  is_positional = excluded.is_positional,
  digit_count   = excluded.digit_count,
  main_count    = excluded.main_count,
  main_max      = excluded.main_max,
  extra_count   = excluded.extra_count,
  extra_max     = excluded.extra_max,
  draw_weekdays = excluded.draw_weekdays,
  active        = true;
