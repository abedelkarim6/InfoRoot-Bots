import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Page from './src/pages/youtube/SchedulesPage.jsx';
const forecast = { status:'ok', seo_words:[{keyword_id:1,keyword:'kw',word:'kw',is_sub:false,priority:3,configured_interval_min:60,effective_interval_min:214.5,next_run_in_min:30,cost_units:101}], channels:[{channel_id:'UC1',channel_name:'Chan',active:true,websub_expires_at:'2026-06-20T10:00:00',last_video_at:'2026-06-14T10:00:00',videos_today:2}], budget:{limit_units:10000,usable_units:9500,reserve_units:500,used_today:905,paused:false,word_search_cost:101} };
global.fetch = async () => ({ status:200, text: async () => JSON.stringify(forecast) });
(async () => {
  const qc = new QueryClient({ defaultOptions:{ queries:{ retry:false } } });
  await qc.prefetchQuery({ queryKey:['yt-sched-forecast'], queryFn: async () => forecast });
  try {
    const html = renderToStaticMarkup(React.createElement(MemoryRouter,null,React.createElement(QueryClientProvider,{client:qc},React.createElement(Page))));
    console.log('RENDER OK len=', html.length);
  } catch (e) { console.log('RENDER THREW:\n', e && e.stack ? e.stack : e); }
})();
