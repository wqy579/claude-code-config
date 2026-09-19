# 记录

1. **1+1=2** — 2026-09-14 17:19

2. **销售单弹窗三单位换算修正 + 批量多选** — 2026-09-19 16:01
   - 文件：`laradmin/frontend/src/views/business/components/sales-order-dialog.vue`
   - F1：`formatStock`/`onSmall`/`onMedium`/`onLarge` 三单位(`c>0 && mc>0`)分支统一到「1大=c中=c*mc小、1中=mc小」口径，与 `requiredSmall`/`quantity` 一致；旧实现把 `c` 当大→小，致件价与库存校验在件/盒/袋齐备的商品上错算
   - F2：三栏第三列加全选 checkbox +「添加选中(N)」，勾选后一次性铺到表格空行，补回旧系统「全选添加」
   - 提交：laradmin 仓库分支 `fix/sales-order-dialog-unit-conversion`（commit `1f98da1`），已 push origin；PR 入口 https://github.com/wqy579/laradmin/pull/new/fix/sales-order-dialog-unit-conversion
   - 纠正前述误判：laradmin 后端在 `modules/Business/`（模块化架构），非「不在树内」
   - 待核对：① `unit_conversion` 字段语义是否=大→中（去 `modules/Business` 的 product 迁移/模型确认）；② `buildPayload` 不发 `quantity`，确认 `SalesOrder` store 自算小单位总量且与 `checkStock` 同公式
