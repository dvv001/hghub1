"""
multi_factor_backtest_fixed.py
多因子量化选股回测框架 — PATCHES.md 已打补丁版（基线原文的逐项修复版）。

基线 multi_factor_backtest.py 未改动；本文件由 apply_fixes.py 从基线逐项替换生成。
已修复（编号见 PATCHES.md / 原始报告 SecOps-04 节）：
  P0-1 停牌归一化凭空加仓（_apply_tradable：冻结日沿用上一有效持仓，不回填原权重）
  P0-2 漂移与 shift 叠加错位（run：先 shift 信号再漂移，不再二次 shift）
  P0-3 调仓日目标权重全 0 静默清仓（_drift_weights_numba：跳过重置并计数告警）
  P1-A fill_median 按列填充致未来函数泄漏（改为截面按行中位数填充）
  P1-B ICIR 权重全样本静态（新增滚动权重面板 icir_weights_panel，默认启用；旧静态路径保留）
  SEC-04 买卖成本分离（印花税仅卖出计；CostConfig 新增 stamp_duty_bps）
  SEC-05 冲击成本量纲（引入 AUM；adv 缺失/非正报错，不再静默归零）
  SEC-06 Newey-West 分母钳制过松（下限 0.25，rho_sum < -0.5 告警）
  SEC-07 年化收益 n_years 与 total_ret 口径（日历天数/365.25；total_ret = nav[-1] - 1.0）
  SEC-08 最大回撤除零与首日 NaN（入口校验；mdd=-1 短路返回）
参数矛盾已按 config.yaml 选定：rf_annual 默认 0.02（原 0.025），MAD 倍数 5.0（原 3.0），
  佣金默认 3bp（原 10bp，config.yaml 万三），滑点 10bp，印花税 10bp 仅卖出。
未修复（留待决定）：P2 项（numba 缓存竞态、float32 内存目标）、最低 5 元佣金、
  max_weight×top_n 可行性（SEC-08 摘要版）—— 见 FIX_NOTES.md。
依赖: pandas>=2.0, numpy>=1.24, numba>=0.58(可选), pyyaml>=6.0
契约: Panel = Dict[str, pd.DataFrame], index=交易日(升序无重复), columns=资产代码, value=float32
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

import numpy as np
import pandas as pd

# ---------- Numba 可选降级 ----------
try:
    from numba import njit
    _HAS_NUMBA = True
except ImportError:  # pragma: no cover
    _HAS_NUMBA = False
    def njit(*a, **k):
        def deco(f): return f
        return deco if not (a and callable(a[0])) else a[0]

Panel = Dict[str, pd.DataFrame]
TRADING_DAYS = 252


# ============================================================
# 0. 配置契约（YAML 注入，禁硬编码 — Research-02 §五）
# ============================================================
@dataclass
class CostConfig:
    commission_bps: float = 3.0    # 单边佣金(万三, config.yaml; 原 10.0 含印花税摊薄已拆分)
    slippage_bps: float = 10.0     # 单边滑点
    stamp_duty_bps: float = 10.0   # 印花税, 仅卖出收取(SEC-04)
    aum: float = 1e8                # 冲击成本模型用资金规模(元, SEC-05: Q = dw * AUM)
    impact_k: float = 0.1          # 平方根冲击模型系数 k·sqrt(Q/ADV)
    use_impact: bool = False

    @property
    def one_way_bps(self) -> float:
        return self.commission_bps + self.slippage_bps


@dataclass
class BacktestConfig:
    rf_annual: float = 0.02        # 无风险利率(复利折算; config.yaml 选定 0.02, 原默认 0.025)
    trading_days: int = TRADING_DAYS
    rebalance_freq: str = "M"      # "D"日频 / "W"周频 / "M"月频
    lag: int = 1                   # 信号→持仓滞后(防未来函数)
    cost: CostConfig = field(default_factory=CostConfig)


@dataclass
class BacktestResult:
    nav: pd.Series
    net_ret: pd.Series
    gross_ret: pd.Series
    turnover: pd.Series
    cost: pd.Series
    positions: pd.DataFrame        # 实际生效权重 w_eff (T×N)
    metrics: Dict[str, float] = field(default_factory=dict)


# ============================================================
# 1. 权重漂移递推（唯一不可纯向量化环节 — Research-02 R2）
# ============================================================
@njit(cache=True)
def _drift_weights_numba(w_target: np.ndarray, returns: np.ndarray,
                         rebal_mask: np.ndarray) -> np.ndarray:
    """
    逐日权重漂移递推: w_t = w_{t-1}(1+r_t) / (1 + Σ w_{t-1} r_t)
    rebal_mask[t]=True 时重置为目标权重。
    w_target, returns: (T, N); 返回 w_eff (T, N)。
    """
    T, N = w_target.shape
    w_eff = np.zeros((T, N), dtype=np.float64)
    prev = np.zeros(N, dtype=np.float64)
    for t in range(T):
        if rebal_mask[t] and np.sum(w_target[t]) >= 1e-8:
            prev = w_target[t].copy()
        else:
            # P0-3: 调仓日目标权重全 0 -> 跳过重置, 当天按非调仓日正常漂移, 不清仓
            pass  # fall through to drift below
            # 漂移: 用 t-1 权重 × t 期收益
            port_ret = 1.0 + np.dot(prev, returns[t])
            if port_ret > 1e-12:
                prev = prev * (1.0 + returns[t]) / port_ret
        w_eff[t] = prev
    return w_eff


def _build_rebalance_mask(index: pd.DatetimeIndex, freq: str) -> np.ndarray:
    """按调仓频率生成调仓日掩码。日频=全True。"""
    if freq.upper() == "D":
        return np.ones(len(index), dtype=bool)
    # 每个周期最后一个交易日为调仓日
    period = index.to_period(freq.upper())
    last_of_period = pd.Series(index, index=index).groupby(period).transform("max")
    return (index == last_of_period.values).astype(bool)


# ============================================================
# 2. 向量化回测引擎（M6）
# ============================================================
class VectorizedBacktester:
    """
    输入: weights (T×N 目标权重, 已含选股+组合约束), returns (T×N 资产收益),
          tradable_mask (T×N bool, 可选)
    输出: BacktestResult
    """

    def __init__(self, cfg: BacktestConfig):
        self.cfg = cfg

    def _apply_tradable(self, weights: pd.DataFrame,
                        tradable: Optional[pd.DataFrame]) -> pd.DataFrame:
        """停牌/涨跌停不可交易 → 权重置0后按行归一化(保持满仓)。"""
        if tradable is None:
            return weights
        w = weights.where(tradable, 0.0)
        row_sum = w.sum(axis=1)
        valid = row_sum > 1e-8
        w = w.div(row_sum.where(valid), axis=0)
        w.loc[~valid] = np.nan          # 标记冻结日
        w = w.ffill().fillna(0.0)       # 沿用上一有效持仓, 不回填原权重(P0-1)
        return w

    def run(self, weights: pd.DataFrame, returns: pd.DataFrame,
            tradable: Optional[pd.DataFrame] = None,
            adv: Optional[pd.DataFrame] = None) -> BacktestResult:
        cfg = self.cfg
        # --- 对齐 ---
        weights = weights.reindex_like(returns).fillna(0.0).astype(np.float64)
        returns = returns.astype(np.float64)
        # 缺失收益视为0(停牌不涨不跌), 但不可与 tradable 混用
        ret_filled = returns.fillna(0.0)

        # --- 可交易约束 ---
        w_target = self._apply_tradable(weights, tradable)

        # --- 防未来函数: 信号先滞后 lag 期, 再喂漂移递推 (P0-2) ---
        # t 期信号 -> t+lag 持仓; 漂移输出即最终持仓, 不再二次 shift。
        w_target_lagged = w_target.shift(cfg.lag).fillna(0.0)
        rebal_mask = _build_rebalance_mask(returns.index, cfg.rebalance_freq)
        w_eff_arr = _drift_weights_numba(
            w_target_lagged.values, ret_filled.values, rebal_mask
        )
        w_eff = pd.DataFrame(w_eff_arr, index=returns.index, columns=returns.columns)
        w_exec = w_eff
        # P0-3 计数: 调仓日目标权重全 0 被跳过的天数
        skipped = int(
            ((w_target_lagged.sum(axis=1) < 1e-8)
             & pd.Series(rebal_mask, index=returns.index)).iloc[cfg.lag:].sum()
        )  # 从 lag 行起计: 前 lag 行全 0 是信号滞后的正常空白, 不是缺失目标
        if skipped:
            warnings.warn(f"跳过 {skipped} 个调仓日重置(目标权重全 0), 沿用上一持仓")

        # --- 组合毛收益 ---
        gross_ret = (w_exec * ret_filled).sum(axis=1)

        # --- 换手(双边口径 /2 = 单边) ---
        dw = w_exec.diff().abs()
        dw.iloc[0] = w_exec.iloc[0].abs()  # 建仓首日
        turnover = dw.sum(axis=1) / 2.0

        # --- 成本 (SEC-04 买卖分离: 印花税仅卖出) ---
        d = w_exec.diff()
        d.iloc[0] = w_exec.iloc[0]  # 建仓首日全算买入
        buy = d.clip(lower=0).sum(axis=1)
        sell = (-d).clip(lower=0).sum(axis=1)
        buy_bps = cfg.cost.commission_bps + cfg.cost.slippage_bps
        sell_bps = buy_bps + cfg.cost.stamp_duty_bps
        cost = (buy * buy_bps + sell * sell_bps) / 1e4
        if cfg.cost.use_impact:
            # SEC-05: Q = dw * AUM(元) 与 adv(元) 同量纲; adv 缺失/非正报错, 禁止静默归零
            if adv is None:
                raise ValueError("use_impact=True 需要提供 adv 成交额面板")
            adv_aligned = adv.reindex_like(returns)
            if adv_aligned.isna().any().any() or (adv_aligned <= 0).any().any():
                raise ValueError("adv 面板含缺失或非正值, 冲击成本无法计算")
            impact_bps = (cfg.cost.impact_k
                          * np.sqrt((dw * cfg.cost.aum / adv_aligned).clip(lower=0))
                          ).sum(axis=1) * 1e4
            cost = cost + turnover * impact_bps / 1e4

        # --- 净收益与净值 ---
        net_ret = gross_ret - cost
        nav = (1.0 + net_ret).cumprod()

        result = BacktestResult(
            nav=nav, net_ret=net_ret, gross_ret=gross_ret,
            turnover=turnover, cost=cost, positions=w_exec,
        )
        result.metrics = PerformanceAnalyzer(cfg).compute_all(result)
        result.metrics["skipped_rebalance_days"] = skipped
        return result


# ============================================================
# 3. 绩效归因（M7）— 与 L1 公式逐项对齐
# ============================================================
class PerformanceAnalyzer:
    def __init__(self, cfg: BacktestConfig):
        self.cfg = cfg

    def sharpe(self, ret: pd.Series) -> Tuple[float, float]:
        """返回 (SR_ann, SR_NW)。"""
        A = self.cfg.trading_days
        rf_daily = (1.0 + self.cfg.rf_annual) ** (1.0 / A) - 1.0
        ex = (ret - rf_daily).dropna()
        if len(ex) < 2 or ex.std(ddof=1) == 0:
            return np.nan, np.nan
        mu, sigma = ex.mean(), ex.std(ddof=1)
        sr = mu / sigma * np.sqrt(A)

        # Newey-West 自相关修正
        T = len(ex)
        q = int(np.floor(4 * (T / 100) ** (2 / 9)))
        q = max(1, min(q, T // 4))
        rho_sum = 0.0
        for k in range(1, q + 1):
            rho_k = ex.autocorr(lag=k)
            if not np.isnan(rho_k):
                rho_sum += (1 - k / (q + 1)) * rho_k
        denom = np.sqrt(max(1 + 2 * rho_sum, 0.25))  # SEC-06: NW 修正最多 4 倍
        if rho_sum < -0.5:
            warnings.warn(f"NW autocorr abnormal: rho_sum={rho_sum:.3f}")
        sr_nw = sr / denom
        return sr, sr_nw

    def max_drawdown(self, nav: pd.Series) -> Dict[str, object]:
        """返回 MDD 及谷底/修复日/区间。"""
        if len(nav) == 0 or pd.isna(nav.iloc[0]) or nav.iloc[0] <= 0:
            raise ValueError("max_drawdown: 首日净值须为正数且非 NaN")  # SEC-08
        nav = nav.ffill()
        peak = nav.cummax()
        dd = nav / peak - 1.0
        mdd = dd.min()
        t_trough = dd.idxmin()
        if mdd <= -1.0 + 1e-12:  # SEC-08: 净值归零, 短路返回
            return {"mdd": -1.0, "trough_date": t_trough,
                    "recover_date": None, "peak_at_trough": float("nan")}
        # 固定谷底峰值(防 cummax 污染 — R7)
        peak_at_trough = nav.loc[t_trough] / (1.0 + mdd)
        after = nav.loc[t_trough:]
        recovered = after[after >= peak_at_trough]
        t_recover = recovered.index[0] if len(recovered) else None
        return {
            "mdd": float(mdd),
            "trough_date": t_trough,
            "recover_date": t_recover,
            "peak_at_trough": float(peak_at_trough),
        }

    def top_drawdowns(self, nav: pd.Series, top_n: int = 3) -> pd.DataFrame:
        """多段回撤 Top-N(行业标准)。"""
        nav = nav.ffill()
        dd = nav / nav.cummax() - 1.0
        in_dd = (dd < 0).astype(int)
        seg_id = in_dd.diff().fillna(0).cumsum()
        segs = []
        for sid, grp in dd[in_dd == 1].groupby(seg_id[in_dd == 1]):
            segs.append({
                "start": grp.index[0], "end": grp.index[-1],
                "depth": grp.min(), "duration": len(grp),
            })
        df = pd.DataFrame(segs).sort_values("depth").head(top_n)
        return df.reset_index(drop=True)

    def compute_all(self, res: BacktestResult) -> Dict[str, float]:
        A = self.cfg.trading_days
        ret = res.net_ret.dropna()
        nav = res.nav
        sr, sr_nw = self.sharpe(ret)
        mdd_info = self.max_drawdown(nav)
        mdd = mdd_info["mdd"]

        # 年化收益(几何) SEC-07: 年数按日历天数, 总收益相对初始 1.0
        total_ret = nav.iloc[-1] / 1.0 - 1.0 if len(nav) else np.nan
        n_years = ((nav.index[-1] - nav.index[0]).days / 365.25
                   if len(nav) > 1 else len(ret) / A)
        ann_ret = (1.0 + total_ret) ** (1.0 / n_years) - 1.0 if n_years > 0 else np.nan
        ann_vol = ret.std(ddof=1) * np.sqrt(A)
        calmar = ann_ret / abs(mdd) if mdd != 0 else np.nan
        ann_turnover = res.turnover.sum() / n_years if n_years > 0 else np.nan

        metrics = {
            "sharpe": sr, "sharpe_nw": sr_nw,
            "ann_return": ann_ret, "ann_vol": ann_vol,
            "mdd": mdd, "calmar": calmar,
            "ann_turnover": ann_turnover,
            "total_cost": res.cost.sum(),
        }
        # 稳健性告警
        if not np.isnan(sr) and not np.isnan(sr_nw) and abs(sr) > 1e-6:
            if abs(sr - sr_nw) / abs(sr) > 0.15:
                warnings.warn(f"Sharpe i.i.d.({sr:.3f}) vs NW({sr_nw:.3f}) 差异>15%, 存在显著自相关")
        return metrics


# ============================================================
# 4. 因子预处理（M3）— MAD(3)→zscore(ddof=0)→中性化
# ============================================================
class FactorPreprocessor:
    @staticmethod
    def mad_winsorize(factor: pd.DataFrame, n: float = 3.0) -> pd.DataFrame:
        med = factor.median(axis=1)
        mad = (factor.sub(med, axis=0)).abs().median(axis=1)
        upper = med + n * mad
        lower = med - n * mad
        return factor.clip(lower=lower, upper=upper, axis=0)

    @staticmethod
    def fill_median(factor: pd.DataFrame) -> pd.DataFrame:
        # P1-A: 截面填充(按行/当日中位数); 原按列填充会用未来值, 是未来函数泄漏
        return factor.T.fillna(factor.median(axis=1)).T

    @staticmethod
    def zscore(factor: pd.DataFrame) -> pd.DataFrame:
        mu = factor.mean(axis=1)
        sd = factor.std(axis=1, ddof=0).replace(0, np.nan)
        return factor.sub(mu, axis=0).div(sd, axis=0)

    @staticmethod
    def neutralize(factor: pd.DataFrame, industry: pd.DataFrame,
                   log_mcap: pd.DataFrame) -> pd.DataFrame:
        """截面 OLS 残差: factor ~ industry_dummy + log_mcap。"""
        out = factor.copy()
        for dt in factor.index:
            y = factor.loc[dt]
            valid = y.notna()
            if valid.sum() < 10:
                continue
            # P2-N: 截距列须为二维, 否则与行业哑变量/市值列 hstack 时维度冲突直接崩(传 industry 或 log_mcap 即触发)
            X_parts = [np.ones(valid.sum()).reshape(-1, 1)]
            if industry is not None and dt in industry.index:
                ind = pd.get_dummies(industry.loc[dt][valid], drop_first=True).values
                X_parts.append(ind)
            if log_mcap is not None and dt in log_mcap.index:
                X_parts.append(log_mcap.loc[dt][valid].values.reshape(-1, 1))
            X = np.hstack(X_parts).astype(np.float64)
            yv = y[valid].values.astype(np.float64)
            try:
                beta, *_ = np.linalg.lstsq(X, yv, rcond=None)
                resid = yv - X @ beta
                out.loc[dt, valid] = resid
            except np.linalg.LinAlgError:
                continue
        return out

    def pipeline(self, factor: pd.DataFrame,
                 industry: Optional[pd.DataFrame] = None,
                 log_mcap: Optional[pd.DataFrame] = None) -> pd.DataFrame:
        f = self.mad_winsorize(factor, 5.0)  # config.yaml 选定 5.0, 原 3.0
        f = self.fill_median(f)
        f = self.zscore(f)
        if industry is not None or log_mcap is not None:
            f = self.neutralize(f, industry, log_mcap)
            f = self.zscore(f)
        return f


# ============================================================
# 5. 多因子合成（M4）— ICIR 加权 + Rank IC
# ============================================================
class FactorCombiner:
    @staticmethod
    def rank_ic(factor: pd.DataFrame, fwd_ret: pd.DataFrame) -> pd.Series:
        """逐期截面 Spearman Rank IC。"""
        ics = {}
        for dt in factor.index:
            f = factor.loc[dt]
            r = fwd_ret.loc[dt]
            valid = f.notna() & r.notna()
            if valid.sum() < 10:
                continue
            # P2-S: Spearman 改写为秩的 Pearson 相关, 与 corr(method="spearman") 数学等价,
            # 但不依赖 scipy (pandas 的 spearman 会 import scipy; iOS Jupyter 等环境常缺 scipy)
            ics[dt] = f[valid].rank().corr(r[valid].rank())
        return pd.Series(ics)

    def icir_weights(self, factor_panels: Dict[str, pd.DataFrame],
                     fwd_ret: pd.DataFrame, window: int = 60) -> pd.Series:
        """滚动 ICIR 加权: w_i ∝ mean(IC_i)/std(IC_i)。"""
        ic_series = {name: self.rank_ic(f, fwd_ret)
                     for name, f in factor_panels.items()}
        ic_df = pd.DataFrame(ic_series)
        mean_ic = ic_df.rolling(window, min_periods=max(12, window // 4)).mean()
        std_ic = ic_df.rolling(window, min_periods=max(12, window // 4)).std(ddof=1)
        icir = (mean_ic / std_ic.replace(0, np.nan)).iloc[-1]
        icir = icir.clip(lower=0)  # 负IC因子截断
        if icir.sum() == 0:
            return pd.Series(1.0 / len(icir), index=icir.index)
        return icir / icir.sum()

    def icir_weights_panel(self, factor_panels: Dict[str, pd.DataFrame],
                           fwd_ret: pd.DataFrame, window: int = 60) -> pd.DataFrame:
        """逐日滚动 ICIR 权重面板(P1-B): t 日权重只用 t-1 及之前的 IC 计算。

        静态版 icir_weights 取全样本最后一行, 是前视偏差, 仅适合因子有效性评估。
        IC 历史不足的早期日期回退等权。
        """
        ic_series = {name: self.rank_ic(f, fwd_ret)
                     for name, f in factor_panels.items()}
        ic_df = pd.DataFrame(ic_series)
        mean_ic = ic_df.rolling(window, min_periods=max(12, window // 4)).mean()
        std_ic = ic_df.rolling(window, min_periods=max(12, window // 4)).std(ddof=1)
        icir = (mean_ic / std_ic.replace(0, np.nan)).clip(lower=0).shift(1)
        row_sum = icir.sum(axis=1)
        w = icir.div(row_sum, axis=0)
        eq = 1.0 / len(icir.columns)
        w = w.where(row_sum > 0, eq).fillna(eq)
        return w

    def combine_panel(self, factor_panels: Dict[str, pd.DataFrame],
                      weights_panel: pd.DataFrame) -> pd.DataFrame:
        """按日期权重面板合成, 输出同 shape 综合因子面板。"""
        out = None
        for name, f in factor_panels.items():
            contrib = f.mul(weights_panel[name], axis=0)
            out = contrib if out is None else out.add(contrib, fill_value=0)
        return out

    def combine(self, factor_panels: Dict[str, pd.DataFrame],
                weights: pd.Series) -> pd.DataFrame:
        """加权合成, 输出同 shape 综合因子面板。"""
        out = None
        for name, f in factor_panels.items():
            w = weights.get(name, 0.0)
            contrib = f * w
            out = contrib if out is None else out.add(contrib, fill_value=0)
        return out


# ============================================================
# 6. 组合构建（M5）— Top-N 等权 + 单票上限
# ============================================================
class PortfolioBuilder:
    def __init__(self, top_n: int = 50, max_weight: float = 0.05):
        self.top_n = top_n
        self.max_weight = max_weight

    def build(self, score: pd.DataFrame,
              tradable: Optional[pd.DataFrame] = None) -> pd.DataFrame:
        """逐期选 Top-N 等权, 应用单票上限。"""
        weights = pd.DataFrame(0.0, index=score.index, columns=score.columns)
        for dt in score.index:
            s = score.loc[dt].dropna()
            if tradable is not None and dt in tradable.index:
                s = s[tradable.loc[dt].reindex(s.index).fillna(False)]
            if len(s) == 0:
                continue
            top = s.nlargest(self.top_n).index
            w = 1.0 / len(top)
            if w > self.max_weight:
                w = self.max_weight
            weights.loc[dt, top] = w
        return weights


# ============================================================
# 7. 编排层（Orchestrator）— 端到端示例
# ============================================================
def run_backtest_pipeline(
    factor_panels: Dict[str, pd.DataFrame],
    returns: pd.DataFrame,
    industry: Optional[pd.DataFrame] = None,
    log_mcap: Optional[pd.DataFrame] = None,
    tradable: Optional[pd.DataFrame] = None,
    cfg: Optional[BacktestConfig] = None,
    use_rolling_weights: bool = True,
) -> BacktestResult:
    """端到端: 预处理→合成→选股→回测→绩效。"""
    cfg = cfg or BacktestConfig()

    # M3 预处理
    pre = FactorPreprocessor()
    processed = {k: pre.pipeline(v, industry, log_mcap)
                 for k, v in factor_panels.items()}

    # M4 合成 (前向收益用于IC计算, 严格 shift(-1) 仅用于IC评估)
    fwd_ret = returns.shift(-1)
    combiner = FactorCombiner()
    if use_rolling_weights:
        # P1-B 默认: 逐日滚动权重, 不用全样本静态权重产出可交易净值
        weights_panel = combiner.icir_weights_panel(processed, fwd_ret, window=60)
        composite = combiner.combine_panel(processed, weights_panel)
    else:
        ic_weights = combiner.icir_weights(processed, fwd_ret, window=60)
        composite = combiner.combine(processed, ic_weights)

    # M5 组合构建
    builder = PortfolioBuilder(top_n=50, max_weight=0.05)
    weights = builder.build(composite, tradable)

    # M6 回测
    engine = VectorizedBacktester(cfg)
    return engine.run(weights, returns, tradable)


if __name__ == "__main__":
    # 冒烟测试: 随机面板
    np.random.seed(42)
    T, N = 500, 100
    idx = pd.date_range("2020-01-01", periods=T, freq="B")
    cols = [f"S{i:03d}" for i in range(N)]
    rets = pd.DataFrame(np.random.randn(T, N) * 0.02, index=idx, columns=cols)
    fac = pd.DataFrame(np.random.randn(T, N), index=idx, columns=cols)
    res = run_backtest_pipeline({"mom": fac}, rets)
    print("Metrics:", {k: round(v, 4) if isinstance(v, float) else v
                       for k, v in res.metrics.items()})
