# 记录

1. **1+1=2** — 2026-09-14 17:19

2. **销售单弹窗三单位换算修正 + 批量多选** — 2026-09-19 16:01
   - 文件：`laradmin/frontend/src/views/business/components/sales-order-dialog.vue`
   - F1：`formatStock`/`onSmall`/`onMedium`/`onLarge` 三单位(`c>0 && mc>0`)分支统一到「1大=c中=c*mc小、1中=mc小」口径，与 `requiredSmall`/`quantity` 一致；旧实现把 `c` 当大→小，致件价与库存校验在件/盒/袋齐备的商品上错算
   - F2：三栏第三列加全选 checkbox +「添加选中(N)」，勾选后一次性铺到表格空行，补回旧系统「全选添加」
   - 提交：laradmin 仓库分支 `fix/sales-order-dialog-unit-conversion`（commit `1f98da1`），已 push origin；PR 入口 https://github.com/wqy579/laradmin/pull/new/fix/sales-order-dialog-unit-conversion
   - 纠正前述误判：laradmin 后端在 `modules/Business/`（模块化架构），非「不在树内」
   - 待核对：① `unit_conversion` 字段语义是否=大→中（去 `modules/Business` 的 product 迁移/模型确认）；② `buildPayload` 不发 `quantity`，确认 `SalesOrder` store 自算小单位总量且与 `checkStock` 同公式

   ⚠️ **后续核实（2026-09-19 晚）：F1 是回归，#4 不可合并**
   - 真实语义（`modules/Stock/Models/Product.php` + `SalesOrderCreateFeatureTest`）：`unit_conversion`(c)=**大→小**（如 480，1件=480个），`unit_conversion_medium`(mc)=**中→小**（如 120，1盒=120个），大→中 = c/mc（=4，派生不存储）。
   - 后端**金额**用物理价：`amount = qty_large*price_large + qty_medium*price_medium + qty_small*price_small`，且 `itemAmount` **信任前端传的 price_large/medium/small**（只不信 amount）；测试显式传 `price_large=480` 才过，故 CI 没覆盖前端自动带出。
   - 后端 `itemQuantity` 三单位 = `ql*c*mc + qm*mc + qs`（=57870，**膨胀 120×**，被测试锁定的遗产口径）；两单位 = `ql*c + qs`（=965，物理）。
   - **F1 错在**：把膨胀口径 `c*mc` 套到了价格自动带出与 formatStock，这俩本该用物理 `c`：
     - `onSmallPriceChange.price_large` `sm*c`(480✓) → `sm*c*mc`(57600✗)
     - `onMediumPriceChange.price_large` `(md/mc)*c`(480✓) → `md*c`(57600✗)
     - `onLargePriceChange.price_small` `lg/c`(1✓) → `lg/(c*mc)`(0.0083✗)
     - `formatStock` 大单位除数 `cn`(480✓) → `cn*mcn`(57600✗)
   - **OLD 唯一真 bug**：`onLargePriceChange.price_medium` = `lg/mc`(4✗) 应为 `(lg/c)*mc`=`lg*mc/c`(120✓)；我的改动也没修对（改成 `lg/c`=1✗）。
   - 后果：前端自动带出件价 57600 而非 480 → 后端按 57600 记金额（本该 750）→ 金额污染。
   - **正确改法**：回滚 F1 的 4 处（恢复物理口径），只修 OLD 的 `onLarge.price_medium`；F2（批量多选）保留。`requiredSmall`(=膨胀 c*mc，与后端 quantity 一致但对比物理库存会 120× 误拦) 是**既有的独立问题**，本次不擅自改，单独立项。
   - token：已写入 `~/.config/gh/hosts.yml`（scope `repo, workflow`，缺 `read:org` 仅影响 `gh auth login` 校验，不影响 API）；PR #4 已存在且 Tests 8 项全绿，但结论是**先修回归再合**。
   - 修正 commit `2e8b5ba`（回滚 F1 4 处 + 修 `onLarge.price_medium`、保留 F2）推送后 PR #4 Tests 重跑全绿；**squash 合并 #4 → main `96ddefe`**（17:58Z），Build & Deploy run `35459699645` 全绿（`Deploy on server: success`），**线上 `bd23fbb`→`96ddefe` 已部署上线**。
   - 遗留：`requiredSmall`/后端 `itemQuantity` 的三单位膨胀口径 `c*mc`（对比物理库存会 mc× 误拦）是独立既有问题，未改，单独立项；前端价格逻辑无单测，建议补。
