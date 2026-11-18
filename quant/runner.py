# 网页版回测运行器(多股票池): 与 multi_factor_backtest_fixed.run_backtest_pipeline
# 同一计算路径, 仅把股票池、PortfolioBuilder 的 top_n 与调仓频率/成本开放为参数。
# 数据为整数编码 CSV(单位 1e-4), 载入时 /10000 还原。
# 在 Pyodide 中由 index.html 载入执行; 本地冒烟测试用同一文件保证口径一致。
import json

import numpy as np
import pandas as pd

from framework import (BacktestConfig, CostConfig, FactorCombiner,
                       FactorPreprocessor, PortfolioBuilder,
                       VectorizedBacktester)

_POOLS = {}


def load_pool(pool):
    """从 data/<pool>/ 载入一个股票池并缓存。"""
    if pool in _POOLS:
        return 'cached'
    base = f'data/{pool}'
    ret = pd.read_csv(f'{base}/returns_i.csv', index_col=0,
                      parse_dates=True) / 10000.0
    fac = pd.read_csv(f'{base}/factor_i.csv', index_col=0,
                      parse_dates=True) / 10000.0
    names = pd.read_csv(f'{base}/names.csv',
                        dtype={'code': str, 'display': str})
    _POOLS[pool] = (ret, fac, names)
    return 'loaded'


def run_bt(pool='hs300', top_n=50, freq='M', years=0, with_cost=True):
    RET, FAC, NAMES = _POOLS[pool]
    name_map = dict(zip(NAMES['symbol'], NAMES['name']))
    if 'display' in NAMES.columns:
        disp_map = dict(zip(NAMES['symbol'], NAMES['display']))
    else:
        disp_map = name_map
    ret, fac = RET, FAC
    if years and int(years) > 0:
        cutoff = RET.index[-1] - pd.DateOffset(years=int(years))
        ret = RET[RET.index > cutoff]
        fac = FAC[FAC.index > cutoff]
    if with_cost:
        cost = CostConfig()
    else:
        cost = CostConfig(commission_bps=0.0, slippage_bps=0.0,
                          stamp_duty_bps=0.0)
    cfg = BacktestConfig(rebalance_freq=str(freq), cost=cost)

    pre = FactorPreprocessor()
    processed = {'mom': pre.pipeline(fac)}
    fwd_ret = ret.shift(-1)
    combiner = FactorCombiner()
    weights_panel = combiner.icir_weights_panel(processed, fwd_ret, window=60)
    composite = combiner.combine_panel(processed, weights_panel)
    builder = PortfolioBuilder(top_n=int(top_n), max_weight=0.05)
    weights = builder.build(composite)
    engine = VectorizedBacktester(cfg)
    res = engine.run(weights, ret)

    nav = res.nav
    dd = nav / nav.cummax() - 1.0
    yearly = (1.0 + res.net_ret).groupby(res.net_ret.index.year).prod() - 1.0
    last = res.positions.iloc[-1]
    holds = last[last > 0.001].sort_values(ascending=False)

    def _f(v):
        v = float(v)
        return None if np.isnan(v) else v

    out = {
        'metrics': {k: _f(v) for k, v in res.metrics.items()},
        'total_return': _f(nav.iloc[-1] - 1.0),
        'start': str(nav.index[0].date()),
        'end': str(nav.index[-1].date()),
        'n_days': int(len(nav)),
        'nav_dates': [d.strftime('%Y-%m-%d') for d in nav.index],
        'nav': [round(float(x), 4) for x in nav.values],
        'dd': [round(float(x), 4) for x in dd.values],
        'yearly': {str(int(y)): round(float(v), 4) for y, v in yearly.items()},
        'holdings': [{'symbol': s, 'code': str(disp_map.get(s, s)),
                      'name': name_map.get(s, ''),
                      'w': round(float(w), 4)} for s, w in holds.items()],
        'hold_date': str(res.positions.index[-1].date()),
    }
    return json.dumps(out)
