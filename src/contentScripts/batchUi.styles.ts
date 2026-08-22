// ── Batch UI chrome: element identity + stylesheet ────────────────────
// Kept apart from batchUi.ts so the ~120 lines of injected CSS don't sit in
// the middle of the selection logic. The id constants live here too because
// the stylesheet interpolates them — they are one unit with it.

export const BATCH_ID = "szuru-batch";
export const SELECTABLE_CLASS = "szuru-batch-selectable";
export const SELECTED_CLASS = "szuru-batch-selected";

export const BATCH_STYLES = `
  /* ── Selection marks on the thumbnails ───────────────────────────── */
  .${SELECTABLE_CLASS}{outline:2px dashed rgba(129,140,248,.55)!important;outline-offset:-2px;
    cursor:pointer!important;position:relative;
    transition:outline-color .16s ease,transform .16s cubic-bezier(.16,1,.3,1)}
  .${SELECTABLE_CLASS}:hover{outline-color:rgba(129,140,248,.95)!important}
  .${SELECTED_CLASS}{outline:3px solid rgba(52,199,89,.95)!important;transform:scale(.97)}
  .${SELECTED_CLASS}::after{content:"";position:absolute;top:5px;left:5px;z-index:2147483646;
    width:20px;height:20px;border-radius:50%;background:rgba(52,199,89,.96);
    background-image:url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3.4 8.4l3 3 6.2-6.6'/%3E%3C/svg%3E");
    background-size:14px 14px;background-position:center;background-repeat:no-repeat;
    box-shadow:0 1px 5px rgba(0,0,0,.45);animation:szb-pop .18s cubic-bezier(.16,1,.3,1) both}
  /* Anchor of a shift-range: the "from" end, so the range is predictable. */
  .${SELECTABLE_CLASS}.szb-range-anchor{outline-color:rgba(255,214,10,.95)!important}

  /* ── The dock ────────────────────────────────────────────────────── */
  #${BATCH_ID}-dock{
    position:fixed;left:16px;bottom:16px;z-index:2147483647;
    display:flex;flex-direction:column;align-items:flex-start;gap:8px;
    max-width:min(480px,calc(100vw - 32px));pointer-events:none;
    font:600 13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI","Helvetica Neue",sans-serif;
    -webkit-font-smoothing:antialiased;}
  #${BATCH_ID}-dock > *{pointer-events:auto}
  #${BATCH_ID}-runs{display:flex;flex-direction:column;align-items:flex-start;gap:6px;width:100%}

  .${BATCH_ID}-panel{
    color:rgba(255,255,255,.95);background:rgba(24,24,28,.86);
    border:.5px solid rgba(255,255,255,.14);border-radius:15px;
    -webkit-backdrop-filter:saturate(180%) blur(36px);backdrop-filter:saturate(180%) blur(36px);
    box-shadow:0 10px 34px rgba(0,0,0,.3),inset 0 .5px 0 rgba(255,255,255,.12);
    animation:szb-rise .24s cubic-bezier(.16,1,.3,1) both;}

  #${BATCH_ID}-launcher{display:flex;align-items:stretch;overflow:hidden}
  #${BATCH_ID}-launcher button{display:flex;align-items:center;gap:7px;padding:9px 13px;cursor:pointer;
    background:none;border:0;color:inherit;font:inherit;transition:background .16s ease}
  #${BATCH_ID}-launcher .szb-open:hover{background:rgba(255,255,255,.09)}
  #${BATCH_ID}-launcher .szb-quick{background:rgba(99,102,241,.4);border-left:.5px solid rgba(255,255,255,.14)}
  #${BATCH_ID}-launcher .szb-quick:hover{background:rgba(99,102,241,.62)}
  #${BATCH_ID}-launcher .szb-basket{padding:1px 7px;border-radius:999px;background:rgba(52,199,89,.22);
    color:rgba(171,255,196,.98);font-size:12px}

  #${BATCH_ID}-toolbar{display:flex;flex-direction:column;gap:8px;padding:11px 12px;
    width:min(480px,calc(100vw - 32px));box-sizing:border-box}
  .${BATCH_ID} .szb-head{display:flex;align-items:center;gap:8px}
  .${BATCH_ID} .szb-title{display:flex;align-items:center;gap:7px;font-size:13px}
  .${BATCH_ID} .szb-tally{margin-left:auto;display:flex;align-items:center;gap:6px;
    font-weight:500;font-size:12px;color:rgba(255,255,255,.62)}
  .${BATCH_ID} .szb-tally b{font-weight:700;font-size:13px;color:rgba(255,255,255,.95);
    font-variant-numeric:tabular-nums}
  .${BATCH_ID} .szb-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .${BATCH_ID} .szb-fields{display:flex;align-items:center;gap:6px}
  .${BATCH_ID} .szb-field{display:flex;align-items:center;gap:6px;flex:1;min-width:120px;
    padding:0 9px;border-radius:10px;border:.5px solid rgba(255,255,255,.16);background:rgba(0,0,0,.28);
    color:rgba(255,255,255,.45);transition:border-color .16s ease,background .16s ease}
  .${BATCH_ID} .szb-field:focus-within{border-color:rgba(129,140,248,.75);background:rgba(0,0,0,.4)}
  .${BATCH_ID} .szb-field input{flex:1;min-width:0;padding:7px 0;border:0;background:none;
    color:rgba(255,255,255,.95);font:inherit;font-weight:500;outline:none}
  .${BATCH_ID} .szb-field input::placeholder{color:rgba(255,255,255,.38);font-weight:400}

  .${BATCH_ID} .szb-btn{display:inline-flex;align-items:center;gap:6px;
    padding:7px 11px;border-radius:10px;border:.5px solid rgba(255,255,255,.16);
    background:rgba(255,255,255,.06);color:inherit;font:inherit;font-size:12.5px;cursor:pointer;
    transition:background .15s ease,border-color .15s ease,transform .12s ease}
  .${BATCH_ID} .szb-btn:hover{background:rgba(255,255,255,.13)}
  .${BATCH_ID} .szb-btn:active{transform:scale(.96)}
  .${BATCH_ID} .szb-btn.primary{background:rgba(99,102,241,.6);border-color:rgba(129,140,248,.55)}
  .${BATCH_ID} .szb-btn.primary:hover{background:rgba(99,102,241,.78)}
  .${BATCH_ID} .szb-btn.danger:hover{background:rgba(255,105,97,.24);border-color:rgba(255,105,97,.4)}
  .${BATCH_ID} .szb-btn.busy{background:rgba(255,159,10,.24);border-color:rgba(255,159,10,.45)}
  .${BATCH_ID} .szb-btn:disabled{opacity:.42;cursor:default;transform:none}
  .${BATCH_ID} .szb-btn.icon-only{padding:7px 8px}
  .${BATCH_ID} .szb-icon{flex-shrink:0;opacity:.92}

  .${BATCH_ID} .szb-note{font-weight:450;font-size:12px;color:rgba(255,255,255,.62);
    display:flex;align-items:center;gap:6px;min-height:16px}
  .${BATCH_ID} .szb-hint{font-weight:400;font-size:11.5px;color:rgba(255,255,255,.4)}

  /* ── Run rows ────────────────────────────────────────────────────── */
  .${BATCH_ID}-run{display:flex;flex-direction:column;gap:7px;padding:10px 12px;
    width:min(480px,calc(100vw - 32px));box-sizing:border-box}
  .${BATCH_ID}-run.done{background:rgba(22,42,30,.86);border-color:rgba(52,199,89,.26)}
  .${BATCH_ID}-run.failed{background:rgba(46,25,25,.88);border-color:rgba(255,105,97,.3)}
  .${BATCH_ID}-run .szb-stats{display:flex;align-items:center;gap:10px;font-weight:500;font-size:11.5px;
    color:rgba(255,255,255,.55);flex-wrap:wrap}
  .${BATCH_ID}-run .szb-stat{display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}
  .${BATCH_ID}-run .szb-stat.ok{color:rgba(120,220,150,.92)}
  .${BATCH_ID}-run .szb-stat.skip{color:rgba(160,180,255,.85)}
  .${BATCH_ID}-run .szb-stat.fail{color:rgba(255,140,130,.92)}
  .${BATCH_ID}-run .szb-eta{margin-left:auto}

  #${BATCH_ID}-runs-summary{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;
    font:inherit;color:inherit;width:auto}
  #${BATCH_ID}-runs-summary:hover{background:rgba(38,38,44,.9)}

  .${BATCH_ID} .szb-collapse{margin-left:auto;display:inline-flex;padding:2px;cursor:pointer;border:0;
    background:none;color:rgba(255,255,255,.45);line-height:0;border-radius:6px;transition:color .15s ease}
  .${BATCH_ID} .szb-collapse:hover{color:rgba(255,255,255,.95);background:rgba(255,255,255,.08)}
  .${BATCH_ID} .szb-dot{width:7px;height:7px;border-radius:50%;background:rgba(129,140,248,.95);flex-shrink:0;
    box-shadow:0 0 0 0 rgba(129,140,248,.5);animation:szb-ping 1.6s cubic-bezier(.16,1,.3,1) infinite}

  .${BATCH_ID} .szb-bar{position:relative;height:5px;border-radius:3px;background:rgba(255,255,255,.12);
    overflow:hidden;width:100%}
  .${BATCH_ID} .szb-bar > i{display:block;height:100%;border-radius:3px;
    background:linear-gradient(90deg,rgba(99,102,241,.95),rgba(168,85,247,.85));
    transition:width .35s cubic-bezier(.16,1,.3,1)}
  .${BATCH_ID} .szb-bar.live::after{content:"";position:absolute;inset:0;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);
    animation:szb-sheen 1.6s ease-in-out infinite}
  .${BATCH_ID}-run.done .szb-bar > i{background:linear-gradient(90deg,rgba(52,199,89,.9),rgba(120,220,150,.8))}

  @keyframes szb-rise{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
  @keyframes szb-pop{from{opacity:0;transform:scale(.55)}to{opacity:1;transform:scale(1)}}
  @keyframes szb-ping{0%{box-shadow:0 0 0 0 rgba(129,140,248,.5)}70%{box-shadow:0 0 0 7px rgba(129,140,248,0)}100%{box-shadow:0 0 0 0 rgba(129,140,248,0)}}
  @keyframes szb-sheen{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
  @media (prefers-reduced-motion:reduce){
    .${BATCH_ID}-panel,.${SELECTED_CLASS}::after{animation:none}
    .${BATCH_ID} .szb-dot,.${BATCH_ID} .szb-bar.live::after{animation:none}
    .${SELECTED_CLASS}{transform:none}
  }
`;
