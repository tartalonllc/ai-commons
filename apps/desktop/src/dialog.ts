import { h } from './dom.js';

/** In-page confirmation; avoids adding the Tauri dialog plugin. */
export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ok = h('button', { type: 'button', class: 'primary' }, 'I understand, enable it');
    const cancel = h('button', { type: 'button', class: 'secondary' }, 'Cancel');
    const dialog = h(
      'dialog',
      { class: 'confirm', 'aria-label': 'Confirm paid provider' },
      h('p', {}, message),
      h('div', { class: 'actions' }, cancel, ok),
    );
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    ok.addEventListener('click', () => finish(true));
    cancel.addEventListener('click', () => finish(false));
    dialog.addEventListener('cancel', () => finish(false));
    document.body.append(dialog);
    dialog.showModal();
  });
}
