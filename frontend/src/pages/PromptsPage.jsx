/**
 * Admin Prompts — admin-only fixed prompts.
 *
 * Two sections: Summaries (system prompt, fixed prefix, bullet-points suffix)
 * and YouTube (video + transcript fixed prefixes). User-managed prompt lists
 * live elsewhere:
 *   - Summaries user prompts → /summaries-prompts (button on the Bots page)
 *   - YouTube  user prompts → /youtube-prompts  (sidebar entry)
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useApiMutation } from '../lib/useApiMutation';
import { useDialogs } from '../dialogs/DialogsProvider';
import { useAuth } from '../auth/AuthContext';
import PageHeader from '../components/PageHeader';

const TABS = [
  { id: 'summaries', label: '📝 Summaries' },
  { id: 'youtube',   label: '🎬 YouTube'   }
];

export default function PromptsPage() {
  const [tab, setTab] = useState('summaries');
  const { user } = useAuth();
  const isAdmin = !user || user.role === 'admin';

  if (!isAdmin) {
    return (
      <div className="page active">
        <PageHeader title="Admin Prompts" />
        <p className="text-muted" style={{ padding: 20 }}>Admin only.</p>
      </div>
    );
  }

  return (
    <div className="page active" id="admin-prompts-page">
      <PageHeader
        title="Admin Prompts"
        subtitle="Fixed prompts that wrap every user prompt — system role, prefix, bullet-points suffix, and YouTube prefixes."
      />

      <div className="bot-config-card">
        <div className="bot-tab-bar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`bot-tab-btn ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="bot-config-body" style={{ padding: 12 }}>
          {tab === 'summaries' && <SummariesFixedAdmin />}
          {tab === 'youtube'   && <YoutubeFixedAdmin />}
        </div>
      </div>
    </div>
  );
}

// ─── Admin Fixed (system/prefix/suffix) for Summaries ──────────────────────

function SummariesFixedAdmin() {
  const { data, isLoading } = useQuery({
    queryKey: ['system', 'fixed-prefix'],
    queryFn: () => api('/api/system/fixed-prefix')
  });
  if (isLoading || !data || data.status === 'error') return null;

  return (
    <>
      <FixedCard
        title="System Prompt"
        field="system_prompt"
        rows={2}
        invalidate={[['system', 'fixed-prefix']]}
        endpoint="/api/system/fixed-prefix/save"
        initial={data.system_prompt ?? data.default_system_prompt ?? ''}
        defaultValue={data.default_system_prompt ?? ''}
      />
      <FixedCard
        title="Fixed Prefix"
        field="fixed_prefix"
        rows={5}
        invalidate={[['system', 'fixed-prefix']]}
        endpoint="/api/system/fixed-prefix/save"
        helper="Injected before every user prompt. Supports: {topic_name}, {messages}, {final_interim}, {b}."
        monospace
        initial={data.fixed_prefix ?? data.default_fixed_prefix ?? ''}
        defaultValue={data.default_fixed_prefix ?? ''}
      />
      <FixedCard
        title="Bullet Points Suffix"
        field="bullet_points_suffix"
        rows={3}
        invalidate={[['system', 'fixed-prefix']]}
        endpoint="/api/system/fixed-prefix/save"
        helper="Appended after the user prompt when a schedule has Bullet Points enabled. Use {b} for the count."
        monospace
        initial={data.bullet_points_suffix ?? data.default_bullet_points_suffix ?? ''}
        defaultValue={data.default_bullet_points_suffix ?? ''}
      />
    </>
  );
}

// ─── Admin Fixed prefixes for YouTube ──────────────────────────────────────

function YoutubeFixedAdmin() {
  const { data, isLoading } = useQuery({
    queryKey: ['yt', 'fixed-prefix'],
    queryFn: () => api('/api/youtube/fixed-prefix')
  });
  if (isLoading || !data || data.status === 'error') return null;

  return (
    <>
      <FixedCard
        title="YouTube Fixed Prefix — Video (URL strategy)"
        field="prefix_video"
        rows={5}
        invalidate={[['yt', 'fixed-prefix']]}
        endpoint="/api/youtube/fixed-prefix/save"
        helper="Injected before the user prompt when Gemini analyzes the video URL directly. Supports {title}, {channel_name}, {link}, {guest}."
        monospace
        initial={data.prefix_video ?? data.default_prefix_video ?? ''}
        defaultValue={data.default_prefix_video ?? ''}
      />
      <FixedCard
        title="YouTube Fixed Prefix — Transcript strategy"
        field="prefix_transcript"
        rows={5}
        invalidate={[['yt', 'fixed-prefix']]}
        endpoint="/api/youtube/fixed-prefix/save"
        helper="Used when a transcript is available. Supports {transcript}, {title}, {channel_name}, {link}, {guest}."
        monospace
        initial={data.prefix_transcript ?? data.default_prefix_transcript ?? ''}
        defaultValue={data.default_prefix_transcript ?? ''}
      />
    </>
  );
}

function FixedCard({
  title, field, rows = 3, helper, monospace, initial, defaultValue,
  endpoint, invalidate
}) {
  const [text, setText] = useState(initial || '');
  const { showAlert } = useDialogs();

  useEffect(() => { setText(initial || ''); }, [initial]);

  const save = useApiMutation(endpoint, {
    invalidate,
    onSuccess: () => showAlert('Saved successfully.'),
    onError:   () => showAlert('Failed to save.')
  });

  return (
    <div className="prompt-card prompt-card-fixed">
      <div className="prompt-card-header">
        <h4 className="prompt-card-title">
          🔒 {title} <span className="admin-badge">Admin</span>
        </h4>
        <div className="prompt-card-actions">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setText(defaultValue || '')}
            title="Reset to default"
          >Reset</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => save.mutate({ [field]: text })}
            disabled={save.isPending}
          >Save</button>
        </div>
      </div>
      {helper && (
        <p className="text-muted" style={{ margin: '0 0 4px', fontSize: 11 }}>{helper}</p>
      )}
      <textarea
        className="textarea"
        rows={rows}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={monospace ? { fontFamily: 'monospace', fontSize: 12 } : undefined}
      />
    </div>
  );
}
