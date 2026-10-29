-- ============================================================================
-- 0009：彩票选号投注
--
-- 足球投注存 bet_leg（场次 × 选项）；彩票是「一组号码 × 倍数」，没有场次，
-- 所以在 bet 上扩展三个字段，而不是再造一张平行表（列表/统计/删除共用一套逻辑）。
--
--   kind             football | lottery
--   lottery_game_no  彩票 game_no（350133 / 04 / 85）
--   lottery_numbers  {"main":[1,2,3,4,5],"extra":[6,7]}（排列五/七星彩 extra 为空）
-- ============================================================================

alter table bet
  add column if not exists kind text not null default 'football',
  add column if not exists lottery_game_no text,
  add column if not exists lottery_numbers jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bet_kind_chk') then
    alter table bet add constraint bet_kind_chk check (kind in ('football', 'lottery'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'bet_lottery_fields_chk') then
    alter table bet add constraint bet_lottery_fields_chk check (
      kind = 'football' or (lottery_game_no is not null and lottery_numbers is not null)
    );
  end if;
end $$;

create index if not exists bet_kind_idx on bet (user_id, kind, placed_at desc);
