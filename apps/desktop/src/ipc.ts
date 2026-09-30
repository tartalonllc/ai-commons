import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { DaemonStatus, ProbeResult, ScheduleMode, WorkerConfig } from '@ai-commons/worker';

export interface SupervisorState {
  state: 'running' | 'restarting' | 'stopped';
  message?: string;
}

/** Everything the UI can ask of the shell. Tests pass a fake. */
export interface Backend {
  getStatus(): Promise<DaemonStatus>;
  getConfig(): Promise<WorkerConfig>;
  saveConfig(config: WorkerConfig): Promise<WorkerConfig>;
  setMode(mode: ScheduleMode): Promise<void>;
  resume(): Promise<void>;
  setKey(provider: string, key: string): Promise<void>;
  deleteKey(provider: string): Promise<void>;
  probeProvider(id: string, endpoint?: string): Promise<ProbeResult>;
  restartWorker(): Promise<void>;
  supervisorState(): Promise<SupervisorState>;
  onStatus(callback: (status: DaemonStatus) => void): Promise<() => void>;
  onSupervisor(callback: (state: SupervisorState) => void): Promise<() => void>;
}

function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>('daemon_request', { method, params });
}

export function tauriBackend(): Backend {
  return {
    getStatus: () => call<DaemonStatus>('getStatus'),
    getConfig: () => call<WorkerConfig>('getConfig'),
    saveConfig: (config) => call<WorkerConfig>('saveConfig', { config }),
    setMode: async (mode) => {
      await call('setMode', { mode });
    },
    resume: async () => {
      await call('resume');
    },
    setKey: async (provider, key) => {
      await call('setKey', { provider, key });
    },
    deleteKey: async (provider) => {
      await call('deleteKey', { provider });
    },
    probeProvider: (id, endpoint) =>
      call<ProbeResult>('probeProvider', endpoint === undefined ? { id } : { id, endpoint }),
    restartWorker: async () => {
      await invoke('restart_worker');
    },
    supervisorState: () => invoke<SupervisorState>('supervisor_state'),
    onStatus: (callback) => listen<DaemonStatus>('worker-event', (e) => callback(e.payload)),
    onSupervisor: (callback) => listen<SupervisorState>('supervisor', (e) => callback(e.payload)),
  };
}
