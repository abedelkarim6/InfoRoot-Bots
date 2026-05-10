import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from './api';
import { useDialogs } from '../dialogs/DialogsProvider';

/**
 * Wraps useMutation so pages don't have to repeat:
 *   - call api(path, body)
 *   - check result.status
 *   - showNotification on success/error
 *   - invalidate query keys
 *
 * Usage:
 *   const restore = useApiMutation('/api/recycle-bin/restore', {
 *     invalidate: ['recycle-bin', 'config'],
 *     successMsg: 'Item restored',
 *     errorMsg: 'Restore failed',
 *   });
 *   restore.mutate({ id });
 */
export function useApiMutation(path, options = {}) {
  const {
    invalidate = [],
    successMsg,
    errorMsg = 'Action failed',
    onSuccess,
    onError
  } = options;

  const qc = useQueryClient();
  const { showNotification } = useDialogs();

  return useMutation({
    mutationFn: (body) => api(path, body || {}),
    onSuccess: (result, variables) => {
      // Treat anything that isn't an explicit error as success. The backend
      // is inconsistent: most routes return status:'ok', but bot/save returns
      // status:'updated', some return only {error:'...'}, etc. Only status
      // values 'error' / 'failed' are real failures; everything else is fine.
      const failed = result?.status === 'error' || result?.status === 'failed' || (result?.error && !result?.status);
      if (failed) {
        // Backend uses {message: "..."} for most routes but {error: "..."}
        // for auth/profile routes — try both before falling back.
        const reason = result?.message || result?.error || errorMsg;
        showNotification(reason, 'error');
        if (onError) onError(result, variables);
        return;
      }
      if (successMsg) {
        const msg = typeof successMsg === 'function' ? successMsg(result, variables) : successMsg;
        if (msg) showNotification(msg, 'success');
      }
      for (const key of invalidate) {
        qc.invalidateQueries({ queryKey: Array.isArray(key) ? key : [key] });
      }
      if (onSuccess) onSuccess(result, variables);
    },
    onError: (err, variables) => {
      showNotification(err?.message || errorMsg, 'error');
      if (onError) onError(err, variables);
    }
  });
}

/**
 * Sugar for an action triggered by a confirm dialog. Returns a callback that
 * shows the dialog and runs the mutation when confirmed.
 *
 *   const confirmDelete = useConfirmedMutation(deleteMutation, {
 *     message: 'Permanently delete this item?',
 *     title: 'Permanent Delete',
 *   });
 *   <button onClick={() => confirmDelete({ id })}>Delete</button>
 */
export function useConfirmedMutation(mutation, dialogOptsOrFn) {
  const { showConfirm } = useDialogs();
  return useCallback(
    (variables) => {
      const opts = typeof dialogOptsOrFn === 'function' ? dialogOptsOrFn(variables) : dialogOptsOrFn;
      const { message, ...rest } = opts;
      showConfirm(message, () => mutation.mutate(variables), rest);
    },
    [mutation, dialogOptsOrFn, showConfirm]
  );
}
