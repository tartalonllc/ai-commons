/**
 * Shown before a volunteer enables a remote provider, by the CLI (`configure`) and
 * by the desktop Settings screen. Keep this module dependency-free: the desktop
 * webview imports it.
 */
export const REMOTE_DISCLOSURE =
  'Note: remote providers receive the full task input for every task they process. ' +
  'Only projects you allow will ever be sent to a remote provider, and projects marked ' +
  'local_models_only are never sent.';
