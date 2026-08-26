/**
 * Preload bridge for the update badge.
 *
 * Runs in the sandboxed renderer before the page loads and exposes exactly
 * one capability surface — window.dshDesktop — so the injected badge can ask
 * for state and trigger actions without gaining any Node/Electron power.
 * Built as CommonJS (dist/preload.cjs): sandboxed preloads are plain scripts.
 * @module
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/** State snapshot handed across IPC (mirrors UpdateState in update.ts). */
type State = Record<string, unknown>

const api = {
  getState: (): Promise<State> => ipcRenderer.invoke('updates:get-state'),
  startDownload: (): Promise<void> => ipcRenderer.invoke('updates:start-download'),
  openReleases: (): Promise<void> => ipcRenderer.invoke('updates:open-releases'),
  openFile: (): Promise<void> => ipcRenderer.invoke('updates:open-file'),
  installNow: (): Promise<void> => ipcRenderer.invoke('updates:install'),
  onStateChanged: (callback: (state: State) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, state: State): void => callback(state)
    ipcRenderer.on('updates:state-changed', handler)
    return () => { ipcRenderer.removeListener('updates:state-changed', handler) }
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)
