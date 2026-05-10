/**
 * AI usage / plan badge — small widget shown in chat-page headers.
 *
 * Mirrors `_renderPlanBadge` + `_applyUsageWidget` in static/js/chatbot.js.
 * Decrements optimistically after each successful AI message via the
 * `useDecrement` ref the parent passes in.
 */
import { useEffect, useImperativeHandle, useState, forwardRef, useCallback } from 'react';
import { api } from '../../lib/api';

const PlanBadge = forwardRef(function PlanBadge(_props, ref) {
  const [state, setState] = useState(null); // { used, limit, remaining, plan_name, has_plan }
  const [limitMsg, setLimitMsg] = useState(null);

  const refresh = useCallback(async () => {
    const d = await api('/api/me/ai-usage');
    if (d && d.has_plan !== undefined) {
      setState(d);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useImperativeHandle(ref, () => ({
    decrement() {
      setState((s) => {
        if (!s || !s.has_plan) return s;
        return {
          ...s,
          used: (s.used ?? 0) + 1,
          remaining: Math.max(0, (s.remaining ?? 0) - 1),
        };
      });
    },
    showLimit(message) {
      setLimitMsg(message);
      refresh();
    },
    clearLimit() {
      setLimitMsg(null);
    },
  }), [refresh]);

  if (!state || !state.has_plan) {
    return limitMsg ? (
      <div className="ai-limit-alert">
        <span>🚫 {limitMsg}</span>
        <button onClick={() => setLimitMsg(null)}>✕</button>
      </div>
    ) : null;
  }

  const used = state.used ?? 0;
  const limit = state.limit ?? 0;
  const remaining = state.remaining ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const planSlug = (state.plan_name || '').toLowerCase().replace(/\s+/g, '-');
  let barCls = 'ai-usage-bar-fill';
  if (pct >= 90) barCls += ' ai-usage-bar-danger';
  else if (pct >= 70) barCls += ' ai-usage-bar-warn';

  return (
    <>
      {limitMsg && (
        <div className="ai-limit-alert">
          <span>🚫 {limitMsg}</span>
          <button onClick={() => setLimitMsg(null)}>✕</button>
        </div>
      )}
      <div className="ai-usage-widget">
        <div className="ai-usage-top">
          <span className={`ac-plan-pill ac-plan-${planSlug}`}>{state.plan_name}</span>
          <span className={`ai-usage-remaining${pct >= 90 ? ' ai-usage-remaining-low' : ''}`}>
            {remaining} left
          </span>
        </div>
        <div className="ai-usage-track">
          <div className={barCls} style={{ width: `${pct}%` }} />
        </div>
        <div className="ai-usage-sub">{used} of {limit} requests used this month</div>
      </div>
    </>
  );
});

export default PlanBadge;
